import { StateManagerInterface } from "@ethereumjs/common";
import { InterpreterStep } from "@ethereumjs/evm";
import { TypedTransaction } from "@ethereumjs/tx";
import { Address } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { addBasicInfo, addOpInfo, MapOnlyTracer, StepVMState, EventDesc, DecodedEventDesc, addEventInfo } from "sol-dbg";
import { CallInfo, CreateInfo } from "./transformers";

/**
 * Interface with additional data regarding a RETURN/STOP op
 */
interface ReturnInfo {
    retData: Uint8Array; // return data
    state: StateManagerInterface; // copy of the state before the return instruction executes
}

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
    excInfo: ExcInfo | undefined
}

export class EVMTracer extends MapOnlyTracer<EVMStep> {
    async processRawTraceStep(
        vm: VM,
        step: InterpreterStep,
        trace: EVMStep[],
        tx: TypedTransaction,
        ctx: null
    ): Promise<[EVMStep, null]> {
        const opInfo = addOpInfo(vm, step, {});
        const basicInfo = await addBasicInfo(vm, step, opInfo, trace);
        const events = await addEventInfo(vm, step, basicInfo, this.artifactManager);

        return [{
            ...events,
            createInfo: undefined,
            callInfo: undefined,
            returnInfo: undefined,
            excInfo: undefined
        }, null];
    }
}
