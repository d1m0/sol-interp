import { Address, createContractAddress, createContractAddress2 } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    OpInfo,
    OPCODES,
    bigEndianBufToNumber,
    bigEndianBufToBigint,
    mustReadMem,
    stackTop,
    stackInd
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { assert } from "../../../utils";
import { TracerContext } from "../tracer";
import { CallFrame } from "./basic_info";

/**
 * Interface with additional data regarding a CREATE/CREATE2 op
 */
export interface CreateInfo {
    address: Address; // New contract address to be created
    value: bigint; // value sent
    msgData: Uint8Array; // msg data
    salt: Uint8Array | undefined;
    nonce: bigint; // caller nonce
    sender: Address;
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
    ctx: TracerContext
): Promise<T & WithCreateInfo> {
    const op = state.op;

    if (op.opcode !== OPCODES.CREATE && op.opcode !== OPCODES.CREATE2) {
        return {
            ...state,
            createInfo: undefined
        };
    }

    const curFrame = stackTop(ctx.callStack);

    const callerAccount = await vm.stateManager.getAccount(step.address);
    assert(callerAccount !== undefined, ``);

    const value = bigEndianBufToBigint(stackTop(state.evmStack));
    const start = bigEndianBufToNumber(stackInd(state.evmStack, 1));
    const size = bigEndianBufToNumber(stackInd(state.evmStack, 2));

    const msgData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    let salt: Uint8Array | undefined;
    if (op.opcode === OPCODES.CREATE2) {
        salt = new Uint8Array(stackInd(state.evmStack, 3));
    }

    const address =
        op.opcode === OPCODES.CREATE
            ? createContractAddress(step.address, callerAccount.nonce)
            : createContractAddress2(step.address, salt as Uint8Array, msgData);

    const newMsg = curFrame.msg.create(value, salt, msgData, callerAccount.nonce);
    const newFrame: CallFrame = {
        msg: newMsg,
        code: newMsg.data,
        callOpStepIdx: trace.length,
        parent: curFrame
    };

    ctx.callStack.push(newFrame);

    const createInfo: CreateInfo = {
        address,
        value,
        msgData,
        salt,
        nonce: callerAccount.nonce,
        sender: step.address
    };

    return {
        ...state,
        createInfo
    };
}
