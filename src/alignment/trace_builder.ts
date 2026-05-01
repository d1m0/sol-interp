import {
    AccountInfo,
    AccountMap,
    CallResult,
    BaseEEI,
    SolMessage,
    BlockManagerI
} from "../interp/env";
import { ArtifactManager } from "../interp/artifactManager";
import { BaseStep, EvalStep, ExecStep } from "../interp/step";
import { TypedTransaction } from "@ethereumjs/tx";
import { Block } from "@ethereumjs/block";
import { ContractInfo, EventDesc, ImmMap, OPCODES, stackTop, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError } from "../interp/exceptions";
import { State } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { EVMStep, isCall, rebuildStateFromTrace } from "./evm_trace";
import { assert } from "../utils";
import {
    eventsMatch,
    EVMCallEvent,
    EVMCreateEvent,
    EVMEmitEvent,
    EVMExceptionEvent,
    EVMGasLeft,
    EVMObservableEvent,
    EVMReturnEvent,
    EVMReturnNoContractEvent,
    findNextEvent,
    SolCallEvent,
    SolCreateEvent,
    SolEmitEvent,
    SolExceptionEvent,
    SolGasLeftEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./observable_events";
import {
    makeCallResultFromStep,
    makeEVMEventFromStep,
    makeSolEventFromStep,
    makeSolMessageFromStep
} from "./utils";
import { AlignedTraces } from "./trace_pairs";
import { bytesToBigInt, bytesToHex } from "@ethereumjs/util";

/**
 * Find the first index `i` in `llTrace` after `afterIdx` at depth `depth`. If the trace depth becomes less than `depth` before
 * reaching `depth`, or we never reach `depth` return -1.
 */
function findFirstIdxAtDepthAfter(llTrace: EVMStep[], depth: number, afterIdx: number): number {
    assert(
        afterIdx >= llTrace.length - 1 || llTrace[afterIdx + 1].depth >= depth,
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

class MisalignmentError extends Error {
    constructor(
        public readonly llEvent: EVMObservableEvent,
        public readonly hlEvent: SolObservableEvent
    ) {
        super();
    }
}

class MatchedInfiniteLoop extends Error {}

export class AlignedTraceBuilder extends BaseEEI {
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
        tx: TypedTransaction,
        blockManager: BlockManagerI,
        maxNumSteps: number | undefined = undefined
    ) {
        super(artifactManager, initialState, block, tx, blockManager, maxNumSteps);
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

    private misalignment(llEvent: EVMObservableEvent, hlEvent: SolObservableEvent): never {
        throw new MisalignmentError(llEvent, hlEvent);
    }

    private addAlignedSegment(
        llEndEvent: EVMObservableEvent,
        hlEndEvent: SolObservableEvent
    ): void {
        this.alignedTraces.push({
            type: "aligned",
            llTrace: this.lowLevelTrace.slice(this.currentLLIdx, llEndEvent.idx + 1),
            hlTrace: this.highLevelTrace,
            llEndEvent,
            hlEndEvent
        });

        this.highLevelTrace = [];
    }

    private addMisalignedSegment(llEvent: EVMObservableEvent, hlEvent: SolObservableEvent): void {
        this.alignedTraces.push({
            type: "misaligned",
            llTrace: this.lowLevelTrace.slice(this.currentLLIdx, llEvent.idx + 1),
            llEndEvent: llEvent,
            hlTrace: this.highLevelTrace,
            hlEndEvent: hlEvent
        });

        this.highLevelTrace = [];
    }

    private addNoSourceSegment(llEvent: EVMObservableEvent): void {
        this.alignedTraces.push({
            type: "no-source",
            llTrace: this.lowLevelTrace.slice(this.currentLLIdx, llEvent.idx + 1),
            llEndEvent: llEvent
        });

        this.highLevelTrace = [];
    }

    private tryMatchObservableEvents(
        llEvent: EVMObservableEvent,
        llStep: EVMStep,
        hlEvent: SolObservableEvent,
        hlAccount: AccountInfo
    ): void {
        // If the next boundary doesn't match the expected call, throw a misalignment error
        if (!eventsMatch(llEvent, llStep, hlEvent, hlAccount)) {
            this.misalignment(llEvent, hlEvent);
        }

        // Add new aligned trace segments
        this.addAlignedSegment(llEvent, hlEvent);
    }

    private updateStateFromLLStep(idx: number): void {
        const correctLowLevelState = rebuildStateFromTrace(
            this.lowLevelTrace,
            this.initialState,
            idx
        );

        let state = ImmMap.fromEntries<string, AccountInfo>([]);
        for (const [addr, otherAccInfo] of correctLowLevelState.entries()) {
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
        this.updateStateFromLLStep(this.currentLLIdx - 1);
    }

    private reSyncAtDepth(expDepth: number): [EVMObservableEvent, SolObservableEvent] {
        let resyncLLIdx: number;

        // Couldnt synchronize at the root
        if (expDepth === 0) {
            resyncLLIdx = this.lowLevelTrace.length;
        } else {
            resyncLLIdx = findFirstIdxAtDepthAfter(this.lowLevelTrace, expDepth, this.currentLLIdx);
        }

        assert(
            resyncLLIdx > 0,
            `Couldn't find an index at depth ${expDepth} after idx ${this.currentLLIdx}`
        );
        const lastStep = this.lowLevelTrace[resyncLLIdx - 1];

        const evmEvent: EVMObservableEvent = makeEVMEventFromStep(lastStep, resyncLLIdx - 1);
        const solEvent: SolObservableEvent = makeSolEventFromStep(lastStep);

        // This sets this.currentLLIdx to resyncLLIdx
        this.addMisalignedSegment(evmEvent, solEvent);
        this.updateStateFromPrevLLStep();

        return [evmEvent, solEvent];
    }

    private getContractInfo(msg: SolMessage): ContractInfo | undefined {
        if (msg.to.equals(ZERO_ADDRESS)) {
            return this.artifactManager.getContractFromCreationBytecode(msg.data);
        }

        const acc = this.getAccount(msg.to);

        if (acc === undefined) {
            return undefined;
        }

        return acc.contract;
    }

    private isCallToAccountWithNoCode(callStep: number): boolean {
        // If we have a call step and an next step (i.e. this is not the root call and not the last step in the trace)
        // Then just check the depths
        if (callStep >= 0 && callStep < this.lowLevelTrace.length - 1) {
            return this.lowLevelTrace[callStep].depth === this.lowLevelTrace[callStep + 1].depth;
        }

        // Otherwise if this is the root call (callStep === -1) check if the trace is empty
        if (callStep < 0) {
            return this.lowLevelTrace.length === 0;
        }

        // Finally if this call is the last step in the trace, then we ran into an exception
        // The call never happened. We shouldn't really get here, as earlier exception event matching should have happened.
        assert(callStep == this.lowLevelTrace.length - 1, `Must be last step`);
        assert(this.lowLevelTrace[callStep].exceptionInfo !== undefined, `Must be an exception`);
        assert(false, `Shouldn't get here`);
    }

    /**
     * Simulate executing messages when we don't have source info. This function
     * recursively calls itself for every call context, as it scans the trace.
     * When we hit a context with source info, we call execMsg
     * @param msg
     */
    execMsgNoSource(msg: SolMessage, calleeFirstStep: number): [CallResult, number] {
        const info = this.getContractInfo(msg);

        // If we have an AST, run the interpreter
        if (info !== undefined) {
            sol.assert(calleeFirstStep >= this.currentLLIdx, ``);

            if (calleeFirstStep > this.currentLLIdx) {
                this.addNoSourceSegment(
                    makeEVMEventFromStep(
                        this.lowLevelTrace[calleeFirstStep - 1],
                        calleeFirstStep - 1
                    )
                );

                this.updateStateFromPrevLLStep();
            }

            sol.assert(this.highLevelTrace.length === 0, `Missed high-level steps`);
            const res = this.execMsg(msg, true);
            return [res, this.currentLLIdx];
        }

        // Special case - handle calls to contracts with no code
        if (this.isCallToAccountWithNoCode(calleeFirstStep - 1)) {
            const fromAccount = this.getAccount(msg.from);
            this.expect(fromAccount !== undefined);

            const reverted = fromAccount.balance < msg.value;

            // This should push an empty low-level no-source trace pair and leave currentLLIdx unchanged
            if (calleeFirstStep > 0) {
                this.addNoSourceSegment(
                    new EVMReturnNoContractEvent(
                        this.currentLLIdx - 1,
                        this.lowLevelTrace[this.currentLLIdx - 1]
                    )
                );
            }

            // Need to update state from the next step to catch the changed balances
            if (0 <= calleeFirstStep && calleeFirstStep < this.lowLevelTrace.length) {
                this.updateStateFromLLStep(calleeFirstStep);
            }

            return [{ reverted, data: new Uint8Array() }, calleeFirstStep];
        }

        let pos = calleeFirstStep;
        let res: CallResult;

        // Seek through the ll trace
        while (pos < this.lowLevelTrace.length) {
            const nextEvent = findNextEvent(this.lowLevelTrace, pos);
            this.expect(nextEvent !== undefined, `Ran out of the trace`);
            const step = this.lowLevelTrace[nextEvent.idx];
            pos = nextEvent.idx + 1;

            if (nextEvent instanceof EVMEmitEvent) {
                // Nothing to do
            } else if (nextEvent instanceof EVMCallEvent || nextEvent instanceof EVMCreateEvent) {
                const msg = makeSolMessageFromStep(step);
                this.addNoSourceSegment(nextEvent);
                this.updateStateFromPrevLLStep();
                [res, pos] = this.execMsgNoSource(msg, pos); // result ignored

                if (pos >= this.lowLevelTrace.length) {
                    return [res, pos];
                }
            } else {
                this.expect(
                    nextEvent instanceof EVMReturnEvent || nextEvent instanceof EVMExceptionEvent
                );
                const resFromStep = makeCallResultFromStep(step);
                this.addNoSourceSegment(nextEvent);
                this.updateStateFromPrevLLStep();

                return [resFromStep, pos];
            }
        }

        this.expect(false, `Shouldn't get here`);
    }

    /**
     * Index of the first yet un-aligned low-level step.
     * Always right after the end of the last aligned segment
     */
    get currentLLIdx(): number {
        if (this.alignedTraces.length === 0) {
            return 0;
        }

        return this.alignedTraces[this.alignedTraces.length - 1].llEndEvent.idx + 1;
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
            assert(llEvent !== undefined, `Couldnt find next event at the start of execMsg`);
            const hlEvent: SolObservableEvent = msg.to.equals(ZERO_ADDRESS)
                ? new SolCreateEvent(msg)
                : new SolCallEvent(msg);

            sol.assert(
                callerAccount !== undefined,
                `Couldn't find caller account for address ${callerAddress.toString()}`
            );

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
        const info = this.getContractInfo(msg);

        if (!info) {
            const [res] = this.execMsgNoSource(msg, this.currentLLIdx);
            return res;
        }

        let res: CallResult;

        try {
            res = super.execMsg(msg);
        } catch (e) {
            if (!(e instanceof MisalignmentError || e instanceof MatchedInfiniteLoop)) {
                throw e;
            }

            if (e instanceof MisalignmentError) {
                const [, solEvent] = this.reSyncAtDepth(callerDepth);
                return solEvent instanceof SolReturnEvent
                    ? solEvent.data
                    : { reverted: true, data: solEvent.data as Uint8Array };
            }

            // Matched a too-long execution in the interpreter with an out-of-gas or stack overflow exception
            res = {
                reverted: true,
                data: new Uint8Array()
            };
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
        assert(llEvent !== undefined, `Couldn't find a return event`);

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

    /**
     * On a gasleft opportunistically seek the next gasleft (not preceded by another event)
     * and take its return
     * @returns
     */
    gasleft(): bigint {
        const nextEvt = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
        const endIdx = nextEvt === undefined ? this.lowLevelTrace.length : nextEvt.idx;

        for (let i = this.currentLLIdx; i < endIdx; i++) {
            if (i === 0) {
                continue;
            }
            const lastStep = this.lowLevelTrace[i - 1];
            if (lastStep.op.opcode !== OPCODES.GAS) {
                continue;
            }

            const top = stackTop(this.lowLevelTrace[i].evmStack);
            const res = bytesToBigInt(top);

            // This updates currentLLIdx
            this.addAlignedSegment(new EVMGasLeft(i - 1, lastStep, res), new SolGasLeftEvent(res));

            return res;
        }

        assert(
            nextEvt !== undefined,
            `Not neccessarily true, if we run out of trace. @todo handle later`
        );
        this.misalignment(nextEvt, new SolGasLeftEvent(-1n));
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
                interp.expect(
                    interp.curNode instanceof sol.EmitStatement ||
                        interp.curNode instanceof sol.FunctionCall,
                    `Unexpected event emit node ${interp.curNode.constructor.name}`
                );
                const call =
                    interp.curNode instanceof sol.EmitStatement
                        ? interp.curNode.vEventCall
                        : interp.curNode;
                const def = call.vReferencedDeclaration;
                interp.expect(def instanceof sol.EventDefinition);

                const signature = sol.signature(def);
                const hash = bytesToHex(sol.signatureHash(def));
                const hlEvent = new SolEmitEvent({
                    evmEvent: evt,
                    signature,
                    hash
                });

                const llEvent = findNextEvent(env.lowLevelTrace, env.currentLLIdx);
                assert(llEvent !== undefined, ``);
                env.tryMatchObservableEvents(
                    llEvent,
                    env.lowLevelTrace[llEvent.idx],
                    hlEvent,
                    state.account
                );
            },
            infiniteLoop: function (interp: Interpreter, state: State): void {
                const llEvent = findNextEvent(env.lowLevelTrace, env.currentLLIdx);
                assert(llEvent !== undefined, ``);
                // Expect an out-of-gas or stack overflow
                const hlEvent = new SolExceptionEvent(new Uint8Array());
                env.tryMatchObservableEvents(
                    llEvent,
                    env.lowLevelTrace[llEvent.idx],
                    hlEvent,
                    state.account
                );
                throw new MatchedInfiniteLoop();
            }
        };

        this.addVisitor(visitor);
        this.execMsgNoSource(this.msg, 0);

        return [this.alignedTraces, this.state];
    }
}
