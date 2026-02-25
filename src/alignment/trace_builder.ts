import { Address, equalsBytes } from "@ethereumjs/util";
import { AccountMap, CallResult, Chain, SolMessage } from "../interp/env";
import { ArtifactManager } from "../interp/artifactManager";
import { AlignedTracesPair, AlignedTraces } from "./aligned_traces";
import { BaseStep, EmitStep, EvalStep, ExecStep } from "../interp/step";
import { TypedTransaction, TypedTxData } from "@ethereumjs/tx";
import { BlockData } from "@ethereumjs/block";
import { EventDesc, ExceptionInfo, nyi, ReturnInfo, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError } from "../interp/exceptions";
import { State } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { findNextBoundary } from "./seek";
import { statesMatch } from "./state_equality";
import { EVMStep, replayEVM } from "./evm_trace";
import { CallInfo, CreateInfo } from "./evm_trace/transformers";

/**
 * Given a `TypedTxData` `tx` and a `sender` `Address` build the corresponding `SolMessage`.
 */
function makeSolMessage(tx: TypedTransaction, sender: Address): SolMessage {
    return {
        from: sender,
        delegatingContract: undefined,
        to: tx.to === undefined ? ZERO_ADDRESS : tx.to,
        data: tx.data,
        gas: tx.gasLimit,
        value: tx.value,
        salt: undefined,
        isStaticCall: false,
        depth: 0
    };
}

/**
 * Given an initial account state, tx and block data, and an artifactManager:
 * 1. Replay the TX and generate an EVM debug trace
 * 2. Interepter the TX at the Solidity level
 * 3. Align the 2 traces and return an aligned traces tree
 */
export async function buildAlignedTraces(
    initialState: AccountMap,
    txData: TypedTxData,
    sender: Address,
    blockData: BlockData,
    artifactManager: ArtifactManager
): Promise<[AlignedTraces<EVMStep, BaseStep>, AccountMap]> {
    // 1. Get the low-level trace
    const [trace, , , tx] = await replayEVM(
        artifactManager,
        initialState,
        txData,
        blockData,
        sender
    );

    // 2. Interpret at the Solidity level
    const builder = new AlignedTraceBuilder(
        artifactManager,
        initialState,
        trace,
        makeSolMessage(tx, sender)
    );
    return builder.buildAlignedTraces();
}

export type EVMObservableEvent = CallInfo | CreateInfo | ReturnInfo | ExceptionInfo;
export type SolObservableEvent = SolMessage | CallResult | RuntimeError;

export type MatchedTracePair = [EVMStep[], BaseStep[], [EVMObservableEvent, SolObservableEvent]];
export type UnmachedTracePair = [EVMStep[], undefined, [EVMObservableEvent, undefined]];
export type TracePair = MatchedTracePair | UnmachedTracePair;
export type AlignedTraces = TracePair[];

class MisalignmentError extends Error {}

export type InterpVisitorEvent =
    | ["call", SolMessage]
    | ["return", Uint8Array]
    | ["exception", RuntimeError]
    | ["event", EventDesc]
    | ["eval", sol.Expression, Value | LValue]
    | ["exec", sol.Statement];

class AlignedTraceBuilder extends Chain {
    currentLLIdx = 0;
    highLevelTrace: BaseStep[] = [];
    alignedTracesStack: Array<Array<AlignedTracesPair<EVMStep, BaseStep>>> = [[]];

    constructor(
        artifactManager: ArtifactManager,
        initialState: AccountMap,
        private readonly lowLevelTrace: EVMStep[],
        private readonly msg: SolMessage
    ) {
        super(artifactManager, initialState);
    }

    private foldOneTraceDown(): void {
        if (this.alignedTracesStack.length > 1) {
            const newTrace = this.alignedTracesStack.pop() as Array<
                AlignedTracesPair<EVMStep, BaseStep>
            >;
            const stackTop = this.alignedTracesStack[this.alignedTracesStack.length - 1];
            sol.assert(stackTop.length > 0, ``);
            sol.assert(stackTop[stackTop.length - 1][2] === null, ``);

            stackTop[stackTop.length - 1][2] = newTrace;
        }
    }

    execMsg(msg: SolMessage): CallResult {
        // Find matching low-level call. If no call found, throw mismatch
        // @todo If index doesn't match the call, throw Mismatch

        let res: CallResult;

        try {
            res = super.execMsg(msg);
        } catch (e) {
            if (!(e instanceof MisalignmentError)) {
                throw e;
            }

            throw e;
        }

        return res;
    }

    handleInterpEvent(interp: Interpreter, state: State, event: InterpVisitorEvent): void {
        const [hlType, ...hlArgs] = event;

        if (hlType === "eval") {
            const [expr, val] = hlArgs as [sol.Expression, Value | LValue];
            this.highLevelTrace.push(new EvalStep(expr, val));
            return;
        } else if (hlType === "exec") {
            this.highLevelTrace.push(new ExecStep(hlArgs[0] as sol.Statement));
            return;
        }

        const [llType, llIdx] = findNextBoundary(this.lowLevelTrace, this.currentLLIdx);

        if (llType !== hlType) {
            const err = new MisalignmentError();
            this.alignedTracesStack[this.alignedTracesStack.length - 1].push([
                this.lowLevelTrace.slice(this.currentLLIdx),
                this.highLevelTrace,
                err
            ]);

            throw err;
        }

        if (!statesMatch(event, interp, state, this.lowLevelTrace, llIdx)) {
            const err = new MisalignmentError();
            this.alignedTracesStack[this.alignedTracesStack.length - 1].push([
                this.lowLevelTrace.slice(this.currentLLIdx),
                this.highLevelTrace,
                err
            ]);

            throw err;
        }

        const lowLevelTrace = this.lowLevelTrace.slice(this.currentLLIdx, llIdx);
        const highLevelSlice = this.highLevelTrace;

        if (llType === "call") {
            this.alignedTracesStack[this.alignedTracesStack.length - 1].push([
                lowLevelTrace,
                highLevelSlice,
                null
            ]);
            this.alignedTracesStack.push([]);
        } else if (llType === "return") {
            this.alignedTracesStack[this.alignedTracesStack.length - 1].push([
                lowLevelTrace,
                highLevelSlice,
                null
            ]);

            this.foldOneTraceDown();
        } else if (llType === "exception") {
            const depthChange =
                this.lowLevelTrace[llIdx - 1].depth - this.lowLevelTrace[llIdx].depth;
            const highLevelSlice = this.highLevelTrace;

            this.alignedTracesStack[this.alignedTracesStack.length - 1].push([
                lowLevelTrace,
                highLevelSlice,
                null
            ]);

            for (let i = 0; i < depthChange; i++) {
                this.foldOneTraceDown();
            }
        } else if (llType === "event") {
            this.highLevelTrace.push(new EmitStep(hlArgs[0] as EventDesc));
        } else {
            nyi(`Low-level trace event ${llType}`);
        }

        this.highLevelTrace = [];
        this.currentLLIdx = llIdx;
    }

    buildAlignedTraces(): [AlignedTraces<EVMStep, BaseStep>, AccountMap] {
        const env = this;

        const visitor = {
            call: function (interp: Interpreter, state: State, msg: SolMessage): void {
                // The first interpreter call corresponds to the start of the trace
                if (
                    env.currentLLIdx === 0 &&
                    equalsBytes(msg.data, env.lowLevelTrace[0].stack[0].msgData)
                ) {
                    return;
                }

                env.handleInterpEvent(interp, state, ["call", msg]);
            },
            return: function (interp: Interpreter, state: State, res: Uint8Array): void {
                env.handleInterpEvent(interp, state, ["return", res]);
            },
            exception: function (interp: Interpreter, state: State, err: RuntimeError): void {
                env.handleInterpEvent(interp, state, ["exception", err]);
            },
            exec: function (interp: Interpreter, state: State, stmt: sol.Statement): void {
                env.handleInterpEvent(interp, state, ["exec", stmt]);
            },
            eval: function (
                interp: Interpreter,
                state: State,
                expr: sol.Expression,
                val: Value | LValue
            ): void {
                env.handleInterpEvent(interp, state, ["eval", expr, val]);
            },
            emit: function (interp: Interpreter, state: State, event: EventDesc): void {
                env.handleInterpEvent(interp, state, ["event", event]);
            }
        };

        this.addVisitor(visitor);
        try {
            this.execMsg(this.msg);
        } catch (e) {
            if (!(e instanceof MisalignmentError)) {
                throw e;
            }

            while (this.alignedTracesStack.length > 1) {
                this.foldOneTraceDown();
            }
        }

        sol.assert(this.alignedTracesStack.length === 1, ``);
        return [this.alignedTracesStack[0], this.state];
    }
}
