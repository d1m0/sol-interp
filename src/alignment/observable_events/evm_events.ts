/**
 * EVM-level events
 */
import { EventDesc } from "sol-dbg";
import { EVMStep } from "../evm_trace";
import { CallInfo, CreateInfo, ExceptionInfo, ReturnInfo } from "../evm_trace/transformers";

type EVMPayloadTypes = CallInfo | CreateInfo | ExceptionInfo | ReturnInfo | EventDesc | bigint;

abstract class EVMEvent<T extends EVMPayloadTypes> {
    constructor(
        public readonly idx: number,
        public readonly step: EVMStep,
        public readonly data: T
    ) {}
}

// EVM trace events
export class EVMCallEvent extends EVMEvent<CallInfo> {}

export class EVMCreateEvent extends EVMEvent<CreateInfo> {}

export class EVMReturnEvent extends EVMEvent<ReturnInfo> {}

export class EVMReturnNoContractEvent extends EVMEvent<ReturnInfo> {
    constructor(idx: number, step: EVMStep) {
        super(idx, step, {
            retData: new Uint8Array(),
            correspCallIdx: -1
        });
    }
}

export class EVMExceptionEvent extends EVMEvent<ExceptionInfo> {}

export class EVMEmitEvent extends EVMEvent<EventDesc> {}

/**
 * This event is not returned by findNextEvent() below, since we have implicit GAS instructions before calls.
 * Instead we explicitly search for GAS calls in AlignedTraceBuilder
 */
export class EVMGasLeft extends EVMEvent<bigint> {}

export type EVMObservableEvent =
    | EVMCallEvent
    | EVMCreateEvent
    | EVMReturnEvent
    | EVMReturnNoContractEvent
    | EVMExceptionEvent
    | EVMEmitEvent
    | EVMGasLeft;

export function findNextEvent(trace: EVMStep[], afterIdx: number): EVMObservableEvent | undefined {
    for (let i = afterIdx; i < trace.length; i++) {
        const step = trace[i];

        if (step.exceptionInfo) {
            return new EVMExceptionEvent(i, step, step.exceptionInfo);
        } else if (step.createInfo) {
            return new EVMCreateEvent(i, step, step.createInfo);
        } else if (step.returnInfo) {
            return new EVMReturnEvent(i, step, step.returnInfo);
        } else if (step.callInfo && !step.callInfo.isPrecompile) {
            return new EVMCallEvent(i, step, step.callInfo);
        } else if (step.emittedEvent) {
            return new EVMEmitEvent(i, step, step.emittedEvent);
        }
    }

    return undefined;
}
