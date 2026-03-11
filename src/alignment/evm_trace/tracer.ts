import { InterpreterStep } from "@ethereumjs/evm";
import { VM } from "@ethereumjs/vm";
import {
    addBasicInfo,
    addOpInfo,
    StepVMState,
    EventDesc,
    BaseSolTxTracer
} from "sol-dbg";
import {
    addCallInfo,
    addCreateInfo,
    addEventInfo,
    addExceptionInfo,
    addReturnInfo,
    CallInfo,
    CreateInfo,
    ExceptionInfo,
    ReturnInfo
} from "./transformers";
import { TypedTransaction } from "@ethereumjs/tx";
import { addSnapshotInfo } from "./transformers/state_snapshot";
import { AccountInfo } from "../../interp";
import { ArtifactManager } from "../../interp/artifactManager";

/**
 * Annotated evm step struct used for aligning traces.
 */
export interface EVMStep extends StepVMState {
    createInfo: CreateInfo | undefined;
    callInfo: CallInfo | undefined;
    returnInfo: ReturnInfo | undefined;
    emittedEvent: EventDesc | undefined;
    exceptionInfo: ExceptionInfo | undefined;
    snapshot: AccountInfo | undefined;
}

interface TracerContext {
    // Stack of indexes of the current *CALL* instructions
    callStack: number[];
}

export class EVMTracer extends BaseSolTxTracer<EVMStep, TracerContext> {
    constructor() {
        // Artifact Manager not used in this tracer
        super(new ArtifactManager([]), { strict: false, foundryCheatcodes: false })
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
        const withCreate = await addCreateInfo(vm, step, events, trace, ctx.callStack);
        const withCall = await addCallInfo(vm, step, withCreate, trace, ctx.callStack);
        const withRet = await addReturnInfo(vm, step, withCall, trace, ctx.callStack, tx);
        const withExceptions = await addExceptionInfo(vm, step, withRet, trace, ctx.callStack);
        const withSnapshot = await addSnapshotInfo(vm, step, withExceptions, trace);

        return [withSnapshot, ctx];
    }
}
