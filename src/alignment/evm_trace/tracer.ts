import { InterpreterStep } from "@ethereumjs/evm";
import { VM } from "@ethereumjs/vm";
import {
    addOpInfo,
    StepVMState,
    EventDesc,
    BaseSolTxTracer,
    TracerOpts,
    FoundryTxResult,
    OPCODES,
    TxReplayInfo
} from "sol-dbg";
import {
    addCallInfo,
    addCreateInfo,
    addEventInfo,
    addExceptionInfo,
    addReturnInfo,
    CallFrame,
    CallInfo,
    CreateInfo,
    ExceptionInfo,
    ExceptionType,
    makeRootFrame,
    ReturnInfo
} from "./transformers";
import { TypedTransaction } from "@ethereumjs/tx";
import { addSnapshotInfo, SnapshotInfo } from "./transformers/state_snapshot";
import { ArtifactManager } from "../../interp/artifactManager";
import { StateManagerInterface } from "@ethereumjs/common";
import { assert } from "../../utils";
import { isOutOfGas } from "./utils";
import { addBasicInfo } from "./transformers/basic_info";

/**
 * Annotated evm step struct used for aligning traces.
 */
export interface EVMStep extends StepVMState {
    createInfo: CreateInfo | undefined;
    callInfo: CallInfo | undefined;
    callFrame: CallFrame;
    returnInfo: ReturnInfo | undefined;
    emittedEvent: EventDesc | undefined;
    exceptionInfo: ExceptionInfo | undefined;
    snapshotInfo: SnapshotInfo | undefined;
}

export interface TracerContext {
    // Stack of indexes of the current *CALL* instructions
    callStack: CallFrame[];
}

export class EVMTracer extends BaseSolTxTracer<EVMStep, TracerContext> {
    constructor(opts: TracerOpts = {}) {
        // Artifact Manager not used in this tracer
        super(new ArtifactManager([]), { strict: false, foundryCheatcodes: false, ...opts });
    }

    async debugTx(
        info: TxReplayInfo
    ): Promise<[EVMStep[], FoundryTxResult, StateManagerInterface, TracerContext]> {
        const ctx = {
            callStack: [await makeRootFrame(info.tx, info.stateBefore)]
        };
        const [trace, txRes, stateAfter, tracerCtx] = await super.debugTx(info, ctx);

        if (trace.length > 0) {
            // Fix-up last step to account for traces ending with a weird exception
            const lastStep = trace[trace.length - 1];

            // If the trace doesnt terminate with a known return or an exception, assume that it terminates with an unknown exception
            if (lastStep.returnInfo === undefined && lastStep.exceptionInfo === undefined) {
                assert(
                    !new Set([OPCODES.RETURN, OPCODES.REVERT, OPCODES.SELFDESTRUCT]).has(
                        lastStep.op.opcode
                    ) && lastStep.op.valid,
                    `Unexpected last opcode with missing info {0}`,
                    lastStep.op.mnemonic
                );
                lastStep.exceptionInfo = {
                    excData: new Uint8Array(),
                    type: isOutOfGas(lastStep) ? ExceptionType.OutOfGas : ExceptionType.Other,
                    correspCallIdx: -1
                };
            }
        }

        return [trace, txRes, stateAfter, tracerCtx];
    }

    async processRawTraceStep(
        vm: VM,
        step: InterpreterStep,
        trace: EVMStep[],
        tx: TypedTransaction,
        ctx: TracerContext
    ): Promise<[EVMStep, TracerContext]> {
        const opInfo = addOpInfo(vm, step, {});
        const basicInfo = await addBasicInfo(vm, step, opInfo, trace);
        const events = await addEventInfo(vm, step, basicInfo);
        const withCreate = await addCreateInfo(vm, step, events, trace, ctx);
        const withCall = await addCallInfo(vm, step, withCreate, trace, tx, ctx);
        const withRet = await addReturnInfo(vm, step, withCall, trace, ctx);
        const withExceptions = await addExceptionInfo(vm, step, withRet, trace, ctx);
        const withSnapshot = await addSnapshotInfo(vm, step, withExceptions, trace, tx);

        return [withSnapshot, ctx];
    }
}
