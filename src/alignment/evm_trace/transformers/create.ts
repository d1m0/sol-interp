import { Address, createContractAddress, createContractAddress2 } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    OpInfo,
    OPCODES,
    bigEndianBufToNumber,
    bigEndianBufToBigint,
    mustReadMem
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { assert } from "../../../utils";

/**
 * Interface with additional data regarding a CREATE/CREATE2 op
 */
export interface CreateInfo {
    address: Address; // New contract address to be created
    value: bigint | undefined; // value sent. undefined for staticcall
    msgData: Uint8Array; // msg data
    salt: Uint8Array | undefined;
    nonce: bigint; // caller nonce
}

export interface WithCreateInfo {
    createInfo: CreateInfo | undefined;
}

/**
 * Adds deployment info for steps that are about to deploy a contract
 */
export async function addCreateInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithCreateInfo>,
    callStack: number[]
): Promise<T & WithCreateInfo> {
    const op = state.op;

    if (op.opcode !== OPCODES.CREATE && op.opcode !== OPCODES.CREATE2) {
        return {
            ...state,
            createInfo: undefined
        };
    }

    callStack.push(trace.length);

    const callerAccount = await vm.stateManager.getAccount(step.address);
    assert(callerAccount !== undefined, ``);

    const stackTop = state.evmStack.length - 1;
    const value = bigEndianBufToBigint(state.evmStack[stackTop]);
    const start = bigEndianBufToNumber(state.evmStack[stackTop - 1]);
    const size = bigEndianBufToNumber(state.evmStack[stackTop - 2]);

    const msgData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    let salt: Uint8Array | undefined;
    if (op.opcode === OPCODES.CREATE2) {
        salt = new Uint8Array(state.evmStack[stackTop - 3]);
    }

    const address =
        op.opcode === OPCODES.CREATE
            ? createContractAddress(step.address, callerAccount.nonce)
            : createContractAddress2(step.address, salt as Uint8Array, msgData);

    const createInfo: CreateInfo = {
        address,
        value,
        msgData,
        salt,
        nonce: callerAccount.nonce
    };

    return {
        ...state,
        createInfo
    };
}
