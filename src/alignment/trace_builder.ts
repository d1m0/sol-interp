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
import { ContractInfo, EventDesc, ImmMap, nyi, OPCODES, stackTop, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError, Unsupported } from "../interp/exceptions";
import { State, takeStateSnapshot } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { EVMStep, rebuildStateFromTrace } from "./evm_trace";
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
    makeSolMessageFromStep
} from "./utils";
import { AlignedTraces, isMisalignmentPairType, PairTypes } from "./trace_pairs";
import { bytesToBigInt, bytesToHex } from "@ethereumjs/util";
import { ExceptionType } from "./evm_trace/transformers";

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

class MatchedInfiniteLoop extends Error { }

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
        private readonly addState: boolean,
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
     * Index of the first yet un-aligned low-level step.
     * Always right after the end of the last aligned segment
     */
    get currentLLIdx(): number {
        if (this.alignedTraces.length === 0) {
            return 0;
        }

        return this.alignedTraces[this.alignedTraces.length - 1].llEndEvent.idx + 1;
    }

    curMode!: PairTypes;

    addSegment(type: PairTypes, llEvent: EVMObservableEvent, hlEvent?: SolObservableEvent, hlAccountInfo?: AccountInfo): void {
        if (type === 'aligned') {
            this.expect(hlEvent !== undefined && hlAccountInfo !== undefined, `Cannot add an aligned segment without a hlEvent and hlAccount`)

            this.tryMatchObservableEvents(
                llEvent,
                this.lowLevelTrace[llEvent.idx],
                hlEvent,
                hlAccountInfo
            );
        } else if (type === 'no-source') {
            this.addNoSourceSegment(llEvent)
        } else if (isMisalignmentPairType(type)) {
            this.alignedTraces.push({
                type,
                llTrace: this.lowLevelTrace.slice(this.currentLLIdx, llEvent.idx + 1),
                llEndEvent: llEvent,
                hlTrace: this.highLevelTrace,
                hlEndEvent: hlEvent,
            });
            this.highLevelTrace = [];
        }
    }
    /**
     * Execute a message. May be called either from:
     * 1) The interpreter - in which case `alreadyAligned` is false, and we first need to align the traces to the next *CALL instruction
     * 2) Recursively by itself - in this case `alreadyAligned` should be true, and the traces already aligned up to the current call
     * 3) by buildAlignedTraces() at the start of the trace - in this case `alreadyAligned` is true, and the traces are trivially aligned since we are at the start
     *
     * This method should:
     * 1. Aligned the traces if `!alreadyAligned` up to the next *CALL instruction
     * 2. Handle the case when this is a call to a contract with no code
     * 3. Remember `mode`
     * 4. If this is a call to a contract with an AST:
     *      4.1 Set mode to 'aligned'
     *      4.2 Invoke interpreter
     *      4.3 If interpreter fails/misaligns, set mode to `misaligned:...`
     *      4.4 Finish this context as if its 'no-source' mode
     * 5. Else if this is a call to a contract without AST, or interpretation failed,
     *      5.1 Step through each observable event in the LL trace, adding an appropriate (according to curMode) segment
     *      5.2 If its a *CALL recusirvely call execMsg()
     *      5.3 If its a RETURN/STOP - return from this context
     *      5.4 If its an Exception - return exception data
     *      5.5 If its an Event/Gasleft - just add the segment
     * 6. Restore rememberd 'mode' and return response
     */
    execMsg(msg: SolMessage, alreadyAligned: boolean = false): CallResult {
        if (!alreadyAligned) {
            // If we are not alreadyAligned to the start of the call, we are in the context of the caller in the llTrace.
            // Align to the next *CALL instruction in the llTrace
            let callerAccount: AccountInfo | undefined;
            let hlEvent: SolObservableEvent | undefined;

            const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            assert(llEvent !== undefined, `Couldnt find next event at the start of execMsg`);

            if (this.curMode === "aligned") {
                const callerAddress =
                    msg.delegatingContract !== undefined ? msg.delegatingContract : msg.from;
                callerAccount = this.state.get(callerAddress.toString());

                hlEvent = msg.to.equals(ZERO_ADDRESS)
                    ? new SolCreateEvent(msg)
                    : new SolCallEvent(msg);

                sol.assert(
                    callerAccount !== undefined,
                    `Couldn't find caller account for address ${callerAddress.toString()}`
                );
            }

            this.addSegment(this.curMode, llEvent, hlEvent, callerAccount)
        }

        const calleeFirstStep = this.currentLLIdx;

        // 2. Handle calls to contracts with no state
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

            return { reverted, data: new Uint8Array() };
        }

        // 3. Remember mdoe
        const oldCurMode = this.curMode

        const info = this.getContractInfo(msg);
        let res: CallResult | undefined;

        // 4. If this is a call to a contract with an AST:
        if (info && info.ast !== undefined) {
            // 4.1 Set mode to 'aligned'
            this.curMode = 'aligned'

            // 4.2 Invoke interpreter
            try {
                res = super.execMsg(msg);

                const calleeAccountAddr =
                    msg.delegatingContract !== undefined
                        ? msg.delegatingContract
                        : res.newContract
                            ? res.newContract
                            : msg.to;


                // If the interepter returned an exception - then everything should already be matched and we can return
                if (res.reverted) {
                    sol.assert(
                        this.highLevelTrace.length === 0,
                        `High-level exception should be matched already if we got here`
                    );
                } else {
                    // Otherwise we need to match the interpreter normal return with an EVM return
                    const hlEvent = new SolReturnEvent(res);
                    const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
                    assert(llEvent !== undefined, `Couldn't find a return event`);
                    const hlAccount = this.state.get(calleeAccountAddr.toString());
                    assert(hlAccount !== undefined, `Missing account for ${calleeAccountAddr.toString()}`);

                    this.tryMatchObservableEvents(
                        llEvent,
                        this.lowLevelTrace[llEvent.idx],
                        hlEvent,
                        hlAccount
                    );
                }
            } catch (e) {
                if (
                    !(
                        e instanceof MisalignmentError ||
                        e instanceof MatchedInfiniteLoop ||
                        (e instanceof Unsupported && e.node instanceof sol.InlineAssembly)
                    )
                ) {
                    throw e;
                }

                // For MatchedInfiniteLoop we have a known result as we matched an OoG or stack overflow and can return
                if (e instanceof MatchedInfiniteLoop) {
                    res = {
                        reverted: true,
                        data: new Uint8Array()
                    };
                } else if (e instanceof Unsupported) {
                    // For unsupported inline assembly - add misalignment segment and continue in no-src mode
                    const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
                    assert(llEvent !== undefined, `Couldn't find a return event`);
                    this.addSegment("misaligned:inline_asm", llEvent, undefined, undefined)
                    this.curMode = "misaligned:earlier"
                    res = undefined
                } else {
                    // For OoG/Error misalignment - add misalignment segment and continue in no-src mode
                    const segType = e.llEvent instanceof EVMExceptionEvent && e.llEvent.data.type === ExceptionType.OutOfGas ? 'misaligned:out-of-gas' : 'misaligned:error'
                    // @todo add hlAccount info to MisalginmentError? Or otherwise get it from somewhere else? Or remove need for it?
                    this.addSegment(segType, e.llEvent)
                    this.curMode = "misaligned:earlier"
                    res = undefined
                }
            }
        } else {
            this.curMode = "no-source"
            const llEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            assert(llEvent !== undefined, `Couldn't find a return event`);
            this.addSegment(this.curMode, llEvent, undefined, undefined)
        }

        // We have a known result for this execution context from interpretation - just restore curMode and return it
        if (res !== undefined) {
            this.curMode = oldCurMode;
            return res;
        }

        // @todo if curMode is `misaligned:inline_asm` since we added a segment for the misalignment, check that we aren't already at the return

        // 5. Else if this is a call to a contract without AST, or interpretation failed,

        // 5.1 Step through each observable event in the LL trace, adding an appropriate(according to curMode) segment
        // Note that we already have a no-source/misalignment segment upon start of the loop to look at.
        while (this.currentLLIdx < this.lowLevelTrace.length) {
            const curEvent = this.alignedTraces[this.alignedTraces.length - 1].llEndEvent;
            const step = this.lowLevelTrace[curEvent.idx];

            if (curEvent instanceof EVMCallEvent || curEvent instanceof EVMCreateEvent) {
                // 5.2 If its a * CALL recusirvely call execMsg()
                const msg = makeSolMessageFromStep(step);
                this.updateStateFromPrevLLStep();
                res = this.execMsg(msg, true);

                if (this.currentLLIdx >= this.lowLevelTrace.length) {
                    this.curMode = oldCurMode;
                    return res;
                }
            } else if (curEvent instanceof EVMReturnEvent || curEvent instanceof EVMExceptionEvent) {
                // 5.3 If its a RETURN / STOP / Exception - return from this context
                const resFromStep = makeCallResultFromStep(step);
                this.updateStateFromPrevLLStep();

                this.curMode = oldCurMode;
                return resFromStep;
            } else if (curEvent instanceof EVMEmitEvent || curEvent instanceof EVMGasLeft) {
                // 5.5 If its an Event / Gasleft - nothing to do
            } else {
                nyi(`Unknown EVM event type ${curEvent.constructor.name}`)
            }

            // Find next evm observable event and add the misaligned/no-source segment
            const nextEvent = findNextEvent(this.lowLevelTrace, this.currentLLIdx);
            this.expect(nextEvent !== undefined, `Ran out of the trace`);

            this.addSegment(this.curMode, nextEvent);
        }

        const curEvent = this.alignedTraces[this.alignedTraces.length - 1].llEndEvent;
        this.expect(curEvent instanceof EVMReturnEvent || curEvent instanceof EVMExceptionEvent);
        const resFromStep = makeCallResultFromStep(this.lowLevelTrace[curEvent.idx]);
        this.updateStateFromPrevLLStep();

        this.curMode = oldCurMode;
        return resFromStep;
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
                env.highLevelTrace.push(
                    new ExecStep(stmt, env.addState ? takeStateSnapshot(state) : undefined)
                );
            },
            eval: function (
                interp: Interpreter,
                state: State,
                expr: sol.Expression,
                val: Value | LValue
            ): void {
                env.highLevelTrace.push(
                    new EvalStep(expr, val, env.addState ? takeStateSnapshot(state) : undefined)
                );
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
        this.execMsg(this.msg, true);

        return [this.alignedTraces, this.state];
    }
}
