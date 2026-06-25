import { Address, bytesToBigInt } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    bigEndianBufToBigint,
    bigEndianBufToNumber,
    mustReadMem,
    OPCODES,
    OpInfo,
    wordToAddress,
    ZERO_ADDRESS
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import * as sol from "solc-typed-ast";
import { PrecomiledAddresses } from "../../utils";
import { TypedTransaction } from "@ethereumjs/tx";
import { CreateInfo, WithCreateInfo } from "./create";

/**
 * Interface with additional data regarding a *CALL* op
 */
export interface CallInfo {
    address: Address; // Target contract address (for delegate calls the address of the account whose storage we are modifying)
    codeAddress: Address; // Address of the executing code (only different from address for delegate calls)
    sender: Address; // Sender is the current contract for everything but DELEGATECALL. DELEGATECALL preserves current sender
    value: bigint; // value sent. Must be 0 for staticcall. Must forward current value for delegatecalls
    gas: bigint; // gas forwarded
    msgData: Uint8Array; // msg data
    nonce: bigint; // caller nonce
    callToNoCodeAccount: boolean; // call to an account with no code
    isPrecompile: boolean; // call is to a precompiled contract
}

export interface WithCallInfo {
    callInfo: CallInfo | undefined;
}

const CALL_OPS = new Set([
    OPCODES.CALL,
    OPCODES.CALLCODE,
    OPCODES.DELEGATECALL,
    OPCODES.STATICCALL
]);

function getRootCallInfo(tx: TypedTransaction, s: BasicStepInfo & OpInfo): CallInfo {
    return {
        address: tx.to === undefined ? ZERO_ADDRESS : tx.to,
        codeAddress: s.address,
        sender: tx.getSenderAddress(),
        value: tx.value,
        gas: tx.gasLimit,
        msgData: tx.data,
        nonce: tx.nonce,
        callToNoCodeAccount: false,
        isPrecompile: false
    };
}

function getCallOrCreateInfoAtStep(
    idx: number,
    trace: Array<LowerStepT & WithCallInfo>,
    tx: TypedTransaction
): CallInfo | CreateInfo {
    if (idx < 0) {
        return getRootCallInfo(tx, trace[0]);
    }

    const step = trace[idx];
    sol.assert(step !== undefined, ``);

    if (step.callInfo) {
        return step.callInfo;
    }

    sol.assert(step.createInfo !== undefined, ``);
    return step.createInfo;
}

export function callWithNoTrace(callInfo: CallInfo): boolean {
    return callInfo.callToNoCodeAccount || callInfo.isPrecompile;
}

type LowerStepT = object & BasicStepInfo & OpInfo & WithCreateInfo;

/**
 * Adds call info for steps that are about to do an external call
 */
export async function addCallInfo<T extends LowerStepT>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithCallInfo>,
    tx: TypedTransaction,
    callStack: number[]
): Promise<T & WithCallInfo> {
    /**
     * Its possible to have "no code" contracts with some code. E.g. for the code is 0xef0100000000009b1d0af20d8c6d0a44e162d11f9b8f00
     * however calls to it, such as the one in tx 0x6a88f3c9a87d492d6f6b6080f4d75b43c8c60bfd80dfd8b39afffd6c423e75a3 succeed
     */
    if (trace.length > 0) {
        const lastStep = trace[trace.length - 1];
        if (lastStep.callInfo !== undefined && lastStep.depth === state.depth) {
            // There are 2 possible ways to get here:
            //  1. Successful call to a "no code" account
            //  2. Exception in the dynamic gas handler of the first instruction of the account, such that we never saw that instruction
            // Sadly there is no clear way to distinguish those. For now (hackily) assume its 1
            if (!lastStep.callInfo.callToNoCodeAccount) {
                callStack.pop();
            }

            lastStep.callInfo.callToNoCodeAccount = true;
        }
    }
    const op = state.op;

    if (!CALL_OPS.has(op.opcode)) {
        return {
            ...state,
            callInfo: undefined
        };
    }

    const lastCallStep = callStack[callStack.length - 1];
    const curInfo = getCallOrCreateInfoAtStep(lastCallStep, trace, tx);

    callStack.push(trace.length);

    const stackTop = state.evmStack.length - 1;
    const argStackOff = op.opcode === OPCODES.CALL || op.opcode === OPCODES.CALLCODE ? 3 : 2;
    const argSizeStackOff = argStackOff + 1;

    const receiverArg = wordToAddress(state.evmStack[stackTop - 1]);

    const address = op.opcode === OPCODES.DELEGATECALL ? state.address : receiverArg;
    const codeAddress = receiverArg;

    const receiverCode = await vm.stateManager.getCode(receiverArg);

    const gas = bigEndianBufToBigint(state.evmStack[stackTop]);
    let value = 0n;

    if (op.opcode === OPCODES.CALL || op.opcode === OPCODES.CALLCODE) {
        value = bigEndianBufToBigint(state.evmStack[stackTop - 2]);
    } else if (op.opcode === OPCODES.DELEGATECALL) {
        value = curInfo.value;
    }

    const start = bigEndianBufToNumber(state.evmStack[stackTop - argStackOff]);
    const size = bigEndianBufToNumber(state.evmStack[stackTop - argSizeStackOff]);
    const msgData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    const isPrecompile = bytesToBigInt(receiverArg.bytes) < PrecomiledAddresses.NUM;
    const callerAccount = await vm.stateManager.getAccount(step.address);
    sol.assert(callerAccount !== undefined, ``);

    const sender = op.opcode === OPCODES.DELEGATECALL ? curInfo.sender : step.address;

    const callInfo: CallInfo = {
        address,
        codeAddress,
        value,
        sender,
        gas,
        msgData,
        nonce: callerAccount.nonce,
        callToNoCodeAccount: receiverCode.length === 0,
        isPrecompile
    };

    // For calls to no-code accounts and precompiles there is no corresponding return. So don't push a call idx on the stack
    if (callWithNoTrace(callInfo)) {
        callStack.pop();
    }

    return {
        ...state,
        callInfo
    };
}
