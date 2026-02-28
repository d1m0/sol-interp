import { Address } from "@ethereumjs/util";
import { AccountMap, CallResult, Chain, SolMessage } from "../interp/env";
import { ArtifactManager } from "../interp/artifactManager";
import { BaseStep, EvalStep, ExecStep } from "../interp/step";
import { TypedTransaction, TypedTxData } from "@ethereumjs/tx";
import { BlockData } from "@ethereumjs/block";
import { EventDesc, nyi, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError } from "../interp/exceptions";
import { State } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { EVMStep, isCall, replayEVM } from "./evm_trace";
import { assert } from "../utils";
import {
    eventsMatch,
    EVMExceptionEvent,
    EVMObservableEvent,
    EVMReturnEvent,
    findNextEvent,
    SolCallEvent,
    SolCreateEvent,
    SolExceptionEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./observable_events";

/**
 * Find the first index `i` in `llTrace` after `afterIdx` at depth `depth`. If the trace depth becomes less than `depth` before
 * reaching `depth`, or we never reach `depth` return -1.
 */
export function findFirstIdxAtDepthAfter(
    llTrace: EVMStep[],
    depth: number,
    afterIdx: number
): number {
    assert(
        afterIdx >= llTrace.length - 1 || llTrace[afterIdx + 1].depth > depth,
        `After idx must be at a higher depth`
    );
    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        if (llTrace[i].depth < depth) {
            return -1;
        }

        if (llTrace[i].depth == depth) {
            return i;
        }
    }

    return -1;
}

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
): Promise<[AlignedTraces, AccountMap]> {
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

export type MatchedTracePair = [EVMStep[], BaseStep[], [EVMObservableEvent, SolObservableEvent]];
export type UnmachedTracePair = [EVMStep[], undefined, [EVMObservableEvent, SolObservableEvent]];
export type TracePair = MatchedTracePair | UnmachedTracePair;
export type AlignedTraces = TracePair[];

function isUnmached(p: TracePair): p is UnmachedTracePair {
    return p[1] === undefined;
}

export function hasUnmached(ps: AlignedTraces): boolean {
    for (const p of ps) {
        if (isUnmached(p)) {
            return true;
        }
    }

    return false;
}

class MisalignmentError extends Error { }

class AlignedTraceBuilder extends Chain {
    currentLLIdx = 0;
    highLevelTrace: BaseStep[] = [];
    alignedTraces: AlignedTraces = [];

    constructor(
        artifactManager: ArtifactManager,
        initialState: AccountMap,
        private readonly lowLevelTrace: EVMStep[],
        private readonly msg: SolMessage
    ) {
        super(artifactManager, initialState);
    }

    private misalignment(): never {
        nyi(``);
    }

    private addAlignedSegment(llEvent: EVMObservableEvent, hlEvent: SolObservableEvent): void {
        this.alignedTraces.push([
            this.lowLevelTrace.slice(this.currentLLIdx, llEvent.idx + 1),
            this.highLevelTrace,
            [llEvent, hlEvent]
        ]);
        this.highLevelTrace = [];
        this.currentLLIdx = llEvent.idx + 1;
    }

    private tryMatchObservableEvents(
        llEvent: EVMObservableEvent,
        hlEvent: SolObservableEvent
    ): void {
        // If the next boundary doesn't match the expected call, throw a misalignment error
        if (!eventsMatch(llEvent, hlEvent)) {
            this.misalignment();
        }

        // Add new aligned trace segments
        this.addAlignedSegment(llEvent, hlEvent);
    }

    execMsg(msg: SolMessage): CallResult {
        let oldCurIdx = this.currentLLIdx;
        const curDepth = this.lowLevelTrace[this.currentLLIdx].depth;
        let llEvent: EVMObservableEvent | undefined;

        if (!(msg.depth === 0 && this.currentLLIdx === 0 && this.highLevelTrace.length === 0)) {
            llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            assert(llEvent !== undefined, ``);
            const hlEvent: SolObservableEvent = msg.to.equals(ZERO_ADDRESS)
                ? new SolCreateEvent(msg)
                : new SolCallEvent(msg);

            this.tryMatchObservableEvents(llEvent, hlEvent);
            oldCurIdx = this.currentLLIdx;
        }

        // Find next low-level trace boundary

        let res: CallResult;

        try {
            res = super.execMsg(msg);
        } catch (e) {
            if (!(e instanceof MisalignmentError)) {
                throw e;
            }

            const resyncLLIdx = findFirstIdxAtDepthAfter(
                this.lowLevelTrace,
                curDepth,
                this.currentLLIdx
            );
            assert(resyncLLIdx > 0, ``);
            const lastStep = this.lowLevelTrace[resyncLLIdx - 1];

            let evmEvent: EVMObservableEvent;

            if (lastStep.returnInfo) {
                evmEvent = new EVMReturnEvent(resyncLLIdx - 1, lastStep);
            } else {
                assert(lastStep.exceptionInfo !== undefined, ``);
                evmEvent = new EVMExceptionEvent(resyncLLIdx - 1, lastStep);
            }

            //this.alignedTraces.push([this.lowLevelTrace.slice(this.currentLLIdx, resyncLLIdx), undefined, [evmEvent,]])
            nyi(`Re-syncing after a misalignment error: ${evmEvent}`);
        }

        if (res.reverted) {
            sol.assert(this.highLevelTrace.length === 0, `High-level exception should be matched already if we got here`);
            return res;
        }

        // Special case - call to a contract with no code succeeds, but has no corresponding RETURN instruction
        if (
            this.currentLLIdx === oldCurIdx &&
            this.currentLLIdx > 0 &&
            isCall(this.lowLevelTrace[this.currentLLIdx - 1]) &&
            this.lowLevelTrace[this.currentLLIdx - 1].depth ===
            this.lowLevelTrace[this.currentLLIdx].depth
        ) {
            // This should push an empty low-level and high-level traces and leave currentLLIdx unchanged
            this.addAlignedSegment(
                new EVMReturnEvent(
                    this.currentLLIdx - 1,
                    this.lowLevelTrace[this.currentLLIdx - 1]
                ),
                new SolReturnEvent(res)
            );

            return res;
        }

        const solEndEvt = new SolReturnEvent(res);

        llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
        assert(llEvent !== undefined, ``);
        this.tryMatchObservableEvents(llEvent, solEndEvt);

        return res;
    }

    buildAlignedTraces(): [AlignedTraces, AccountMap] {
        const env = this;

        const visitor = {
            call: function (interp: Interpreter, state: State, msg: SolMessage): void {
                // Nothing to do
            },
            return: function (interp: Interpreter, state: State, res: Uint8Array): void {
                // Nothing to do
            },
            exception: function (interp: Interpreter, state: State, err: RuntimeError): void {
                const hlEvent = new SolExceptionEvent(err.payload);
                const llEvent = findNextEvent(env.lowLevelTrace, env.currentLLIdx);
                assert(llEvent !== undefined, ``);
                env.tryMatchObservableEvents(llEvent, hlEvent);
            },
            exec: function (interp: Interpreter, state: State, stmt: sol.Statement): void {
                env.highLevelTrace.push(new ExecStep(stmt));
            },
            eval: function (
                interp: Interpreter,
                state: State,
                expr: sol.Expression,
                val: Value | LValue
            ): void {
                env.highLevelTrace.push(new EvalStep(expr, val));
            },
            emit: function (interp: Interpreter, state: State, event: EventDesc): void {
                // @todo match events
            }
        };

        this.addVisitor(visitor);
        this.execMsg(this.msg);

        return [this.alignedTraces, this.state];
    }
}
