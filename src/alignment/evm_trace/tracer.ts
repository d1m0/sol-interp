import { InterpreterStep } from "@ethereumjs/evm";
import { VM } from "@ethereumjs/vm";
import { addBasicInfo, addOpInfo, MapOnlyTracer, StepVMState, EventDesc, DecodedEventDesc, addEventInfo } from "sol-dbg";
import { addCallInfo, addCreateInfo, addReturnInfo, CallInfo, CreateInfo, ReturnInfo } from "./transformers";

/**
 * Interface describing exception data.
 */
interface ExcInfo {
    excData: Uint8Array;
    isGas: boolean
}

/**
 * Annotated evm step struct used for aligning traces.
 */
export interface EVMStep extends StepVMState {
    createInfo: CreateInfo | undefined;
    callInfo: CallInfo | undefined;
    returnInfo: ReturnInfo | undefined;
    emittedEvent: EventDesc | undefined;
    decodedEvent: DecodedEventDesc | undefined;
    exceptionInfo: ExcInfo | undefined
}

export class EVMTracer extends MapOnlyTracer<EVMStep> {
    async processRawTraceStep(
        vm: VM,
        step: InterpreterStep,
        trace: EVMStep[],
    ): Promise<[EVMStep, null]> {
        const opInfo = addOpInfo(vm, step, {});
        const basicInfo = await addBasicInfo(vm, step, opInfo, trace);
        const events = await addEventInfo(vm, step, basicInfo, this.artifactManager);
        const withCreate = await addCreateInfo(vm, step, events)
        const withCall = await addCallInfo(vm, step, withCreate)
        const withRet = await addReturnInfo(vm, step, withCall)

        return [{
            ...withRet,
            exceptionInfo: undefined
        }, null];
    }
}
