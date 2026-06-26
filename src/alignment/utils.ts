import { CallResult, SolMessage } from "../interp";
import { WithExceptionInfo, WithReturnInfo } from "./evm_trace/transformers";
import { assert } from "../utils";
import { Address, createAddressFromBigInt } from "@ethereumjs/util";
import { EVMStep } from "./evm_trace";
import {
    EVMCallEvent,
    EVMCreateEvent,
    EVMEmitEvent,
    EVMExceptionEvent,
    EVMObservableEvent,
    EVMReturnEvent,
    SolExceptionEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./observable_events";
import { OPCODES } from "sol-dbg";

/**
 * Build the SolMessage that will be created from a CREATE/*CALL step.
 * Note that this is different from step.msg. `step.msg` is the `SolMessage` of the current caller context.
 * This function returns the `SolMessage` of the callee context.
 */
export function makeSolMessageFromCallCreateStep(s: EVMStep): SolMessage {
    const msg = s.callFrame.msg;

    if (s.callInfo) {
        if (s.op.opcode === OPCODES.DELEGATECALL) {
            return msg.delegatecall(s.callInfo.gas, s.callInfo.codeAddress, s.callInfo.msgData);
        }

        if (s.op.opcode === OPCODES.CALLCODE) {
            return msg.callcode(
                s.callInfo.gas,
                s.callInfo.codeAddress,
                s.callInfo.value,
                s.callInfo.msgData
            );
        }

        if (s.op.opcode === OPCODES.STATICCALL) {
            return msg.staticcall(s.callInfo.gas, s.callInfo.codeAddress, s.callInfo.msgData);
        }

        assert(s.op.opcode === OPCODES.CALL, `Unknown call opcode ${s.op.mnemonic}`);

        return msg.call(
            s.callInfo.gas,
            s.callInfo.codeAddress,
            s.callInfo.value,
            s.callInfo.msgData
        );
    } else {
        assert(s.createInfo !== undefined, ``);

        return msg.create(
            s.createInfo.value,
            s.createInfo.salt,
            s.createInfo.msgData,
            s.createInfo.nonce
        );
    }
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
        return new EVMExceptionEvent(i, step, step.exceptionInfo);
    } else if (step.createInfo) {
        return new EVMCreateEvent(i, step, step.createInfo);
    } else if (step.returnInfo) {
        return new EVMReturnEvent(i, step, step.returnInfo);
    } else if (step.callInfo) {
        return new EVMCallEvent(i, step, step.callInfo);
    } else {
        assert(
            step.emittedEvent !== undefined,
            `Step {0} is not an externally observable EVM step`,
            i
        );
        return new EVMEmitEvent(i, step, step.emittedEvent);
    }
}

export function makeSolEventFromStep(s: EVMStep): SolObservableEvent {
    if (s.returnInfo) {
        return new SolReturnEvent(makeCallResultFromStep(s));
    } else if (s.exceptionInfo) {
        return new SolExceptionEvent(s.exceptionInfo.excData);
    } else {
        assert(false, `Not expected resync event step ${s}`);
    }
}

export enum PrecomiledAddresses {
    EC_RECOVER = 1,
    SHA256,
    RIPEMD160,
    IDENTITY,
    MODEXP,
    ECADD,
    ECMUL,
    ECPAIRING,
    BLAKE2F,
    NUM
}

const precompiles: Address[] = [
    createAddressFromBigInt(BigInt(PrecomiledAddresses.EC_RECOVER)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.SHA256)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.RIPEMD160)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.IDENTITY)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.MODEXP)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.ECADD)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.ECMUL)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.ECPAIRING)),
    createAddressFromBigInt(BigInt(PrecomiledAddresses.BLAKE2F))
];

export function isPrecompile(addr: Address): boolean {
    for (let i = 0; i < precompiles.length; i++) {
        if (precompiles[i].equals(addr)) {
            return true;
        }
    }

    return false;
}
