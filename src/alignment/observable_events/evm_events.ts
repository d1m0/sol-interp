/**
 * EVM-level events
 */
import { EventDesc } from "sol-dbg";
import { assert } from "../../utils";
import { EVMStep } from "../evm_trace";
import { CallInfo, CreateInfo, ExceptionInfo, ReturnInfo } from "../evm_trace/transformers";

type EVMPayloadTypes = CallInfo | CreateInfo | ExceptionInfo | ReturnInfo | EventDesc;

abstract class EVMEvent<T extends EVMPayloadTypes> {
    public readonly data: T;

    protected abstract _getPayload(): T | undefined;

    constructor(
        public readonly idx: number,
        public readonly step: EVMStep
    ) {
        const res = this._getPayload();
        assert(res !== undefined, ``);
        this.data = res;
    }
}

// EVM trace events
export class EVMCallEvent extends EVMEvent<CallInfo> {
    protected _getPayload(): CallInfo | undefined {
        return this.step.callInfo;
    }
}

export class EVMCreateEvent extends EVMEvent<CreateInfo> {
    protected _getPayload(): CreateInfo | undefined {
        return this.step.createInfo;
    }
}

export class EVMReturnEvent extends EVMEvent<ReturnInfo> {
    protected _getPayload(): ReturnInfo | undefined {
        assert(this.step.returnInfo !== undefined, ``);
        return this.step.returnInfo;
    }
}

export class EVMReturnNoContractEvent extends EVMEvent<ReturnInfo> {
    protected _getPayload(): ReturnInfo | undefined {
        return {
            retData: new Uint8Array(),
            state: {},
            correspCallIdx: -1
        };
    }
}

export class EVMExceptionEvent extends EVMEvent<ExceptionInfo> {
    protected _getPayload(): ExceptionInfo | undefined {
        return this.step.exceptionInfo;
    }
}

export class EVMEmitEvent extends EVMEvent<EventDesc> {
    protected _getPayload(): EventDesc | undefined {
        return this.step.emittedEvent;
    }
}

export type EVMObservableEvent =
    | EVMCallEvent
    | EVMCreateEvent
    | EVMReturnEvent
    | EVMReturnNoContractEvent
    | EVMExceptionEvent
    | EVMEmitEvent;

export function findNextEvent(trace: EVMStep[], afterIdx: number): EVMObservableEvent | undefined {
    for (let i = afterIdx + 1; i < trace.length; i++) {
        const step = trace[i];

        if (step.exceptionInfo) {
            return new EVMExceptionEvent(i, step);
        } else if (step.createInfo) {
            return new EVMCreateEvent(i, step);
        } else if (step.returnInfo) {
            return new EVMReturnEvent(i, step);
        } else if (step.callInfo) {
            return new EVMCallEvent(i, step);
        } else if (step.emittedEvent) {
            return new EVMEmitEvent(i, step);
        }
    }

    return undefined;
}
