import { Address, bytesToBigInt } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    bigEndianBufToBigint,
    bigEndianBufToNumber,
    mustReadMem,
    OPCODES,
    OpInfo,
    wordToAddress
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import * as sol from "solc-typed-ast";
import { PrecomiledAddresses } from "../../utils";

/**
 * Interface with additional data regarding a *CALL* op
 */
export interface CallInfo {
    address: Address; // Target contract address
    codeAddress: Address; // Address of the executing code (only different from address for delegate calls)
    value: bigint | undefined; // value sent. undefined for staticcall
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

/**
 * Adds call info for steps that are about to do an external call
 */
export async function addCallInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithCallInfo>,
    callStack: number[]
): Promise<T & WithCallInfo> {
    const op = state.op;

    if (!CALL_OPS.has(op.opcode)) {
        return {
            ...state,
            callInfo: undefined
        };
    }

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
    }

    const start = bigEndianBufToNumber(state.evmStack[stackTop - argStackOff]);
    const size = bigEndianBufToNumber(state.evmStack[stackTop - argSizeStackOff]);
    const msgData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    const isPrecompile = bytesToBigInt(receiverArg.bytes) < PrecomiledAddresses.NUM;
    const callerAccount = await vm.stateManager.getAccount(step.address);
    sol.assert(callerAccount !== undefined, ``);

    const callInfo: CallInfo = {
        address,
        codeAddress,
        value,
        gas,
        msgData,
        nonce: callerAccount.nonce,
        callToNoCodeAccount: receiverCode.length === 0,
        isPrecompile
    };

    // For calls to no-code accounts and precompiles there is no corresponding return. So don't push a call idx on the stack
    if (callInfo.callToNoCodeAccount || callInfo.isPrecompile) {
        callStack.pop();
    }

    return {
        ...state,
        callInfo
    };
}
