import { BasicStepInfo, OPCODES, OpInfo, ZERO_ADDRESS } from "sol-dbg";
import { CallResult, SolMessage } from "../interp";
import {
    WithCallInfo,
    WithCreateInfo,
    WithExceptionInfo,
    WithReturnInfo
} from "./evm_trace/transformers";
import { assert } from "../utils";
import { Address } from "@ethereumjs/util";
import { EVMStep } from "./evm_trace";
import {
    EVMCallEvent,
    EVMCreateEvent,
    EVMEmitEvent,
    EVMExceptionEvent,
    EVMObservableEvent,
    EVMReturnEvent,
    SolCallEvent,
    SolCreateEvent,
    SolEmitEvent,
    SolExceptionEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./observable_events";

export function makeSolMessageFromStep(
    s: BasicStepInfo & OpInfo & WithCallInfo & WithCreateInfo
): SolMessage {
    const from: Address = s.address;
    let delegatingContract: Address | undefined;
    let to: Address;
    let data: Uint8Array;
    let gas: bigint;
    let value: bigint;
    let salt: Uint8Array | undefined;
    let isStaticCall: boolean;
    const depth: number = s.depth;

    if (s.callInfo) {
        delegatingContract =
            s.op.opcode === OPCODES.DELEGATECALL || s.op.opcode === OPCODES.CALLCODE
                ? s.callInfo.codeAddress
                : undefined;
        to = s.callInfo.codeAddress;
        data = s.callInfo.msgData;
        gas = s.callInfo.gas;
        value = s.callInfo.value === undefined ? 0n : s.callInfo.value;
        salt = undefined;
        isStaticCall = s.op.opcode === OPCODES.STATICCALL;
    } else {
        assert(s.createInfo !== undefined, ``);
        delegatingContract = undefined;
        to = ZERO_ADDRESS;
        data = s.createInfo.msgData;
        gas = 0n;
        value = s.createInfo.value === undefined ? 0n : s.createInfo.value;
        salt = s.createInfo.salt;
        isStaticCall = false;
    }
    return {
        from,
        delegatingContract,
        to,
        data,
        gas,
        value,
        salt,
        isStaticCall,
        depth
    };
}

export function makeCallResultFromStep(s: WithReturnInfo & WithExceptionInfo): CallResult {
    if (s.returnInfo) {
        return {
            reverted: false,
            data: s.returnInfo.retData,
            newContract: s.returnInfo.newContract
        };
    } else {
        assert(s.exceptionInfo !== undefined, `Missing exception info`);
        return {
            reverted: true,
            data: s.exceptionInfo.excData
        };
    }
}

export function makeEVMEventFromStep(step: EVMStep, i: number): EVMObservableEvent {
    if (step.exceptionInfo) {
        return new EVMExceptionEvent(i, step);
    } else if (step.createInfo) {
        return new EVMCreateEvent(i, step);
    } else if (step.returnInfo) {
        return new EVMReturnEvent(i, step);
    } else if (step.callInfo) {
        return new EVMCallEvent(i, step);
    } else {
        assert(
            step.emittedEvent !== undefined,
            `Step {0} is not an externally observable EVM step`,
            i
        );
        return new EVMEmitEvent(i, step);
    }
}

export function makeSolEventFromStep(s: EVMStep): SolObservableEvent {
    if (s.callInfo !== undefined || s.createInfo !== undefined) {
        const msg = makeSolMessageFromStep(s);
        return s.callInfo !== undefined ? new SolCallEvent(msg) : new SolCreateEvent(msg);
    } else if (s.returnInfo) {
        return new SolReturnEvent(makeCallResultFromStep(s));
    } else if (s.exceptionInfo) {
        return new SolExceptionEvent(s.exceptionInfo.excData);
    } else {
        assert(s.emittedEvent !== undefined, `Step ${s} is not an externally observable EVM step`);
        return new SolEmitEvent(s.emittedEvent);
    }
}
