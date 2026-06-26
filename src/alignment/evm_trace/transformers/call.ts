import { Address } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    bigEndianBufToBigint,
    bigEndianBufToNumber,
    mustReadMem,
    OPCODES,
    OpInfo,
    stackInd,
    stackTop,
    wordToAddress,
    ZERO_ADDRESS
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import * as sol from "solc-typed-ast";
import { isPrecompile } from "../../utils";
import { TypedTransaction } from "@ethereumjs/tx";
import { WithCreateInfo } from "./create";
import { SolMessage } from "../../../interp";
import { makeSolMessage } from "../../trace_builder";
import { StateManagerInterface } from "@ethereumjs/common";
import { TracerContext } from "../tracer";

export interface CallFrame {
    // SolMessage giving rise to the current CallFrame
    msg: SolMessage;
    // Code being evaluated in the current CallFrame. Note that for contract creation frames this includes the constructor args.
    code: Uint8Array;
    // Index of the CALL/CREATE/CREATE2/DELEGATECALL/STATICCALL/CALLCODE opcode causing this frame.
    // -1 for the root frame
    callOpStepIdx: number;
    parent: CallFrame | undefined;
}

export async function makeRootFrame(
    tx: TypedTransaction,
    state: StateManagerInterface
): Promise<CallFrame> {
    let code: Uint8Array;
    if (tx.to === undefined || tx.to.equals(ZERO_ADDRESS)) {
        // creation
        code = tx.data;
    } else {
        code = await state.getCode(tx.to);
    }

    return {
        msg: makeSolMessage(tx),
        code,
        callOpStepIdx: -1,
        parent: undefined
    };
}

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
    callFrame: CallFrame;
}

const CALL_OPS = new Set([
    OPCODES.CALL,
    OPCODES.CALLCODE,
    OPCODES.DELEGATECALL,
    OPCODES.STATICCALL
]);

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
    ctx: TracerContext
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
                ctx.callStack.pop();
            }

            lastStep.callInfo.callToNoCodeAccount = true;
        }
    }

    const op = state.op;
    const curFrame: CallFrame = stackTop(ctx.callStack);

    if (!CALL_OPS.has(op.opcode)) {
        return {
            ...state,
            callInfo: undefined,
            callFrame: curFrame
        };
    }

    let gas: bigint;
    let receiver: Address;
    let value: bigint;
    let msgData: Uint8Array;
    let newMsg: SolMessage;

    if (op.opcode === OPCODES.CALL) {
        gas = bigEndianBufToBigint(stackTop(state.evmStack));
        receiver = wordToAddress(stackInd(state.evmStack, 1));
        value = bigEndianBufToBigint(stackInd(state.evmStack, 2));
        const argOffset = bigEndianBufToNumber(stackInd(state.evmStack, 3));
        const argSize = bigEndianBufToNumber(stackInd(state.evmStack, 4));
        msgData = argSize === 0 ? new Uint8Array() : mustReadMem(argOffset, argSize, state.memory);
        newMsg = curFrame.msg.call(gas, receiver, value, msgData);
    } else if (op.opcode === OPCODES.CALLCODE) {
        gas = bigEndianBufToBigint(stackTop(state.evmStack));
        receiver = wordToAddress(stackInd(state.evmStack, 1));
        value = bigEndianBufToBigint(stackInd(state.evmStack, 2));
        const argOffset = bigEndianBufToNumber(stackInd(state.evmStack, 3));
        const argSize = bigEndianBufToNumber(stackInd(state.evmStack, 4));
        msgData = argSize === 0 ? new Uint8Array() : mustReadMem(argOffset, argSize, state.memory);
        newMsg = curFrame.msg.callcode(gas, receiver, value, msgData);
    } else if (op.opcode === OPCODES.DELEGATECALL) {
        gas = bigEndianBufToBigint(stackTop(state.evmStack));
        receiver = wordToAddress(stackInd(state.evmStack, 1));
        const argOffset = bigEndianBufToNumber(stackInd(state.evmStack, 2));
        const argSize = bigEndianBufToNumber(stackInd(state.evmStack, 3));
        msgData = argSize === 0 ? new Uint8Array() : mustReadMem(argOffset, argSize, state.memory);
        newMsg = curFrame.msg.delegatecall(gas, receiver, msgData);
        value = curFrame.msg.value;
    } else {
        sol.assert(op.opcode === OPCODES.STATICCALL, `NYI Call op {0}`, op.mnemonic);
        gas = bigEndianBufToBigint(stackTop(state.evmStack));
        receiver = wordToAddress(stackInd(state.evmStack, 1));
        value = 0n;
        const argOffset = bigEndianBufToNumber(stackInd(state.evmStack, 2));
        const argSize = bigEndianBufToNumber(stackInd(state.evmStack, 3));
        msgData = argSize === 0 ? new Uint8Array() : mustReadMem(argOffset, argSize, state.memory);
        newMsg = curFrame.msg.staticcall(gas, receiver, msgData);
    }

    const code = await vm.stateManager.getCode(receiver);
    const newFrame: CallFrame = {
        msg: newMsg,
        code,
        callOpStepIdx: trace.length,
        parent: curFrame
    };

    ctx.callStack.push(newFrame);

    const callerAccount = await vm.stateManager.getAccount(step.address);
    sol.assert(callerAccount !== undefined, ``);

    const sender = op.opcode === OPCODES.DELEGATECALL ? curFrame.msg.sender : step.address;

    const callInfo: CallInfo = {
        address:
            op.opcode === OPCODES.DELEGATECALL || op.opcode === OPCODES.CALLCODE
                ? state.address
                : receiver,
        codeAddress: receiver,
        value,
        sender,
        gas,
        msgData,
        nonce: callerAccount.nonce,
        callToNoCodeAccount: code.length === 0,
        isPrecompile: isPrecompile(receiver)
    };

    // For calls to no-code accounts and precompiles there is no corresponding return. So don't push a call idx on the stack
    if (callWithNoTrace(callInfo)) {
        ctx.callStack.pop();
    }

    return {
        ...state,
        callInfo,
        callFrame: curFrame
    };
}
