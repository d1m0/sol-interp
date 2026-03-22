import { Address } from "@ethereumjs/util";
import { AccountInfo, AccountMap, CallResult, Chain, SolMessage } from "../interp/env";
import { ArtifactManager } from "../interp/artifactManager";
import { BaseStep, EvalStep, ExecStep } from "../interp/step";
import { TypedTransaction, TypedTxData } from "@ethereumjs/tx";
import { Block, BlockData } from "@ethereumjs/block";
import { ContractInfo, EventDesc, ImmMap, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError } from "../interp/exceptions";
import { State } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { EVMStep, isCall, rebuildStateFromTrace, replayEVM } from "./evm_trace";
import { assert } from "../utils";
import {
    eventsMatch,
    EVMCallEvent,
    EVMCreateEvent,
    EVMEmitEvent,
    EVMExceptionEvent,
    EVMObservableEvent,
    EVMReturnEvent,
    EVMReturnNoContractEvent,
    findNextEvent,
    SolCallEvent,
    SolCreateEvent,
    SolEmitEvent,
    SolExceptionEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./observable_events";
import {
    makeCallResultFromStep,
    makeEVMEventFromStep,
    makeSolEventFromStep,
    makeSolMessageFromStep
} from "./utils";

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
export function makeSolMessage(tx: TypedTransaction): SolMessage {
    return {
        from: tx.getSenderAddress(),
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
    artifactManager: ArtifactManager,
    maxNumSteps: number | undefined = undefined
): Promise<[AlignedTraces, AccountMap]> {
    // 1. Get the low-level trace
    const [trace, , , block, tx] = await replayEVM(initialState, txData, blockData, sender);

    // 2. Interpret at the Solidity level
    const builder = new AlignedTraceBuilder(
        artifactManager,
        initialState,
        trace,
        makeSolMessage(tx),
        block,
        maxNumSteps
    );
    return builder.buildAlignedTraces();
}

export type MatchedTracePair = [EVMStep[], BaseStep[], [EVMObservableEvent, SolObservableEvent]];
export type UnmachedTracePair = [EVMStep[], undefined, [EVMObservableEvent, SolObservableEvent]];
export type TracePair = MatchedTracePair | UnmachedTracePair;
export type AlignedTraces = TracePair[];

export function isUnmached(p: TracePair): p is UnmachedTracePair {
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

class MisalignmentError extends Error {}

export class AlignedTraceBuilder extends Chain {
    currentLLIdx = 0;
    highLevelTrace: BaseStep[] = [];
    alignedTraces: AlignedTraces = [];
    // Map from LL trace indices of starts of new exection context to the LL trace idx right after their corresponding return/revert
    correspEndIdx = new Map<number, number>();

    constructor(
        artifactManager: ArtifactManager,
        private readonly initialState: AccountMap,
        private readonly lowLevelTrace: EVMStep[],
        private readonly msg: SolMessage,
        block: Block,
        maxNumSteps: number | undefined = undefined
    ) {
        super(artifactManager, initialState, block, maxNumSteps);
        for (let i = 0; i < this.lowLevelTrace.length; i++) {
            const step = this.lowLevelTrace[i];

            if (step.returnInfo) {
                this.correspEndIdx.set(step.returnInfo.correspCallIdx, i);
            }

            if (step.exceptionInfo) {
                this.correspEndIdx.set(step.exceptionInfo.correspCallIdx, i);
            }
        }
    }

    private misalignment(): never {
        throw new MisalignmentError();
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

    private addMisalignedSegment(llEvent: EVMObservableEvent, hlEvent: SolObservableEvent): void {
        this.alignedTraces.push([
            this.lowLevelTrace.slice(this.currentLLIdx, llEvent.idx + 1),
            undefined,
            [llEvent, hlEvent]
        ]);

        this.highLevelTrace = [];
        this.currentLLIdx = llEvent.idx + 1;
    }

    private tryMatchObservableEvents(
        llEvent: EVMObservableEvent,
        llStep: EVMStep,
        hlEvent: SolObservableEvent,
        hlAccount: AccountInfo
    ): void {
        // If the next boundary doesn't match the expected call, throw a misalignment error
        if (!eventsMatch(llEvent, llStep, hlEvent, hlAccount)) {
            this.misalignment();
        }

        // Add new aligned trace segments
        this.addAlignedSegment(llEvent, hlEvent);
    }

    private updateStateFrom(otherState: AccountMap): void {
        let state = ImmMap.fromEntries<string, AccountInfo>([]);
        for (const [addr, otherAccInfo] of otherState.entries()) {
            const myAccInfo = this.state.get(addr);
            state = state.set(addr, {
                address: otherAccInfo.address,
                contract: myAccInfo !== undefined ? myAccInfo.contract : undefined,
                deployedBytecode: otherAccInfo.deployedBytecode,
                storage: otherAccInfo.storage,
                balance: otherAccInfo.balance,
                nonce: otherAccInfo.nonce
            });
        }

        this.state = state;
    }

    private updateStateFromPrevLLStep(): void {
        const correctLowLevelState = rebuildStateFromTrace(
            this.lowLevelTrace,
            this.initialState,
            this.currentLLIdx - 1
        );
        this.updateStateFrom(correctLowLevelState);
    }

    private reSyncAtDepth(expDepth: number): [EVMObservableEvent, SolObservableEvent] {
        let resyncLLIdx: number;

        if (this.currentLLIdx === 0 && expDepth === 1) {
            // Couldnt synchronize at the first call
            resyncLLIdx = this.lowLevelTrace.length;
        } else {
            resyncLLIdx = findFirstIdxAtDepthAfter(this.lowLevelTrace, expDepth, this.currentLLIdx);
        }

        assert(resyncLLIdx > 0, ``);
        const lastStep = this.lowLevelTrace[resyncLLIdx - 1];

        const evmEvent: EVMObservableEvent = makeEVMEventFromStep(lastStep, resyncLLIdx - 1);
        const solEvent: SolObservableEvent = makeSolEventFromStep(lastStep);

        // This sets this.currentLLIdx to resyncLLIdx
        this.addMisalignedSegment(evmEvent, solEvent);
        this.updateStateFromPrevLLStep();

        return [evmEvent, solEvent];
    }

    private getContractInfo(msg: SolMessage, step: EVMStep): ContractInfo | undefined {
        if (msg.to.equals(ZERO_ADDRESS)) {
            return this.artifactManager.getContractFromCreationBytecode(msg.data);
        }

        const addr = step.codeAddress !== undefined ? step.codeAddress : step.address;
        const acc = this.getAccount(addr);
        this.expect(acc !== undefined, `Missing account for ${addr.toString()}`);
        return acc.contract;
    }

    /**
     * Simulate executing messages when we don't have source info. This function
     * recursively calls itself for every call context, as it scans the trace.
     * When we hit a context with source info, we call execMsg
     * @param msg
     */
    execMsgNoSource(msg: SolMessage): CallResult {
        const calleeFirstStep = this.currentLLIdx;
        const info = this.getContractInfo(msg, this.lowLevelTrace[calleeFirstStep]);

        // If we have an AST, run the interpreter
        if (info !== undefined) {
            sol.assert(calleeFirstStep >= this.lastSegmentEnd, ``);
            this.currentLLIdx = calleeFirstStep;

            if (this.currentLLIdx > this.lastSegmentEnd + 1) {
                const isCreate = msg.to.equals(ZERO_ADDRESS);
                this.addMisalignedSegment(
                    makeEVMEventFromStep(
                        this.lowLevelTrace[this.currentLLIdx - 1],
                        this.currentLLIdx - 1
                    ),
                    isCreate ? new SolCreateEvent(msg) : new SolCallEvent(msg)
                );

                this.updateStateFromPrevLLStep();
            }

            sol.assert(this.highLevelTrace.length === 0, `Missed high-level steps`);
            return this.execMsg(msg, true);
        }

        // Seek through the ll trace
        while (this.currentLLIdx < this.lowLevelTrace.length) {
            const nextEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            this.expect(nextEvent !== undefined, `Ran out of the trace`);
            const step = this.lowLevelTrace[nextEvent.idx];
            this.currentLLIdx = nextEvent.idx + 1;

            if (nextEvent instanceof EVMEmitEvent) {
                // Nothing to do
            } else if (nextEvent instanceof EVMCallEvent || nextEvent instanceof EVMCreateEvent) {
                const msg = makeSolMessageFromStep(step);
                this.execMsgNoSource(msg); // result ignored
            } else {
                this.expect(
                    nextEvent instanceof EVMReturnEvent || nextEvent instanceof EVMExceptionEvent
                );
                const res = makeCallResultFromStep(step);
                this.updateStateFromPrevLLStep();

                if (this.currentLLIdx === this.lowLevelTrace.length) {
                    // Reached end of the trace in contract without code - add a final mis-alignment segment
                    this.addMisalignedSegment(
                        nextEvent,
                        makeSolEventFromStep(this.lowLevelTrace[this.currentLLIdx - 1])
                    );
                }

                return res;
            }
        }

        this.expect(false, `Shouldn't get here`);
    }

    get lastSegmentEnd(): number {
        if (this.alignedTraces.length === 0) {
            return 0;
        }

        return this.alignedTraces[this.alignedTraces.length - 1][2][0].idx;
    }

    /**
     * Execute a message. May be called either from:
     * 1) the interpreter, in which case we need to find the matching call in the low-level trace and align first
     * 2) from alignMessage()/initially, in which case we may assume that the traces are already aligned up to currentLLIdx
     *
     * When we are called from the interpreter `llIdxAtStartOfCallee` will be false, and we will re-sync with the low-level trace upon entry.
     */
    execMsg(msg: SolMessage, llIdxAtStartOfCallee: boolean = false): CallResult {
        // Here we are in the context of the caller.
        // If there are unaligned LL steps, try and find the matching call in the LL trace and
        if (!llIdxAtStartOfCallee) {
            const callerAddress =
                msg.delegatingContract !== undefined ? msg.delegatingContract : msg.from;
            const callerAccount = this.state.get(callerAddress.toString());

            const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            assert(llEvent !== undefined, ``);
            const hlEvent: SolObservableEvent = msg.to.equals(ZERO_ADDRESS)
                ? new SolCreateEvent(msg)
                : new SolCallEvent(msg);

            sol.assert(callerAccount !== undefined, ``);

            this.tryMatchObservableEvents(
                llEvent,
                this.lowLevelTrace[llEvent.idx],
                hlEvent,
                callerAccount
            );
        }

        // At this point this.currentLLIdx is the first step in the callee context
        // Index of the first low-level step in the callee context
        const calleeStartIdx = this.currentLLIdx;
        const callerDepth = this.lowLevelTrace[this.currentLLIdx].depth - 1;
        const info = this.getContractInfo(msg, this.lowLevelTrace[calleeStartIdx]);

        if (!info) {
            return this.execMsgNoSource(msg);
        }

        let res: CallResult;

        try {
            res = super.execMsg(msg);
        } catch (e) {
            if (!(e instanceof MisalignmentError)) {
                throw e;
            }

            const [, solEvent] = this.reSyncAtDepth(callerDepth);
            return solEvent instanceof SolReturnEvent
                ? solEvent.data
                : { reverted: true, data: solEvent.data as Uint8Array };
        }

        if (res.reverted) {
            sol.assert(
                this.highLevelTrace.length === 0,
                `High-level exception should be matched already if we got here`
            );
            return res;
        }

        // Special case - call to a contract with no code succeeds, but has no corresponding RETURN instruction
        if (
            this.currentLLIdx === calleeStartIdx &&
            this.currentLLIdx > 0 &&
            isCall(this.lowLevelTrace[this.currentLLIdx - 1]) &&
            this.lowLevelTrace[this.currentLLIdx - 1].depth ===
                this.lowLevelTrace[this.currentLLIdx].depth
        ) {
            // This should push an empty low-level and high-level traces and leave currentLLIdx unchanged
            this.addAlignedSegment(
                new EVMReturnNoContractEvent(
                    this.currentLLIdx - 1,
                    this.lowLevelTrace[this.currentLLIdx - 1]
                ),
                new SolReturnEvent(res)
            );

            return res;
        }

        const hlEvent = new SolReturnEvent(res);
        const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
        assert(llEvent !== undefined, ``);

        const calleeAccountAddr =
            msg.delegatingContract !== undefined
                ? msg.delegatingContract
                : res.newContract
                  ? res.newContract
                  : msg.to;

        const hlAccount = this.state.get(calleeAccountAddr.toString());
        assert(hlAccount !== undefined, `Missing account for ${calleeAccountAddr.toString()}`);

        try {
            this.tryMatchObservableEvents(
                llEvent,
                this.lowLevelTrace[llEvent.idx],
                hlEvent,
                hlAccount
            );
        } catch (e) {
            if (!(e instanceof MisalignmentError)) {
                throw e;
            }

            const [, solEvent] = this.reSyncAtDepth(callerDepth);
            return solEvent instanceof SolReturnEvent
                ? solEvent.data
                : { reverted: true, data: solEvent.data as Uint8Array };
        }

        return res;
    }

    buildAlignedTraces(): [AlignedTraces, AccountMap] {
        const env = this;

        const visitor = {
            call: function (): void {
                // Nothing to do
            },
            return: function (): void {
                // Nothing to do
            },
            exception: function (interp: Interpreter, state: State, err: RuntimeError): void {
                const hlEvent = new SolExceptionEvent(err.payload);
                const llEvent = findNextEvent(env.lowLevelTrace, env.currentLLIdx);
                assert(llEvent !== undefined, ``);
                env.tryMatchObservableEvents(
                    llEvent,
                    env.lowLevelTrace[llEvent.idx],
                    hlEvent,
                    state.account
                );
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
            emit: function (interp: Interpreter, state: State, evt: EventDesc): void {
                const hlEvent = new SolEmitEvent(evt);
                const llEvent = findNextEvent(env.lowLevelTrace, env.currentLLIdx);
                assert(llEvent !== undefined, ``);
                env.tryMatchObservableEvents(
                    llEvent,
                    env.lowLevelTrace[llEvent.idx],
                    hlEvent,
                    state.account
                );
            },
            infiniteLoop: function (): void {
                env.misalignment();
            }
        };

        this.addVisitor(visitor);
        this.currentLLIdx = 0;
        this.execMsgNoSource(this.msg);

        return [this.alignedTraces, this.state];
    }
}
