import { SolMessage } from "../../../interp";
import { WithCallInfo } from "./call";
import { WithCreateInfo } from "./create";
import { WithExceptionInfo } from "./exceptions";
import { WithReturnInfo } from "./return";
import { VM } from "@ethereumjs/vm";
import { InterpreterStep } from "@ethereumjs/evm";
import { TypedTransaction } from "@ethereumjs/tx";
import { BasicStepInfo, OPCODES, OpInfo } from "sol-dbg";
import { assert } from "solc-typed-ast";

export interface WithMessage {
    msg: SolMessage;
}

type LowerStepT = object &
    BasicStepInfo &
    OpInfo &
    WithCallInfo &
    WithCreateInfo &
    WithReturnInfo &
    WithExceptionInfo;

/**
 * Adds call info for steps that are about to do an external call
 */
export async function addMessage<T extends LowerStepT>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithMessage>,
    tx: TypedTransaction
): Promise<T & WithMessage> {
    if (trace.length === 0) {
        return {
            ...state,
            msg: SolMessage.fromTx(tx)
        };
    }

    const lastStep = trace[trace.length - 1];

    /*
    // @todo for debugging only. delete
    if (lastStep.op.opcode === OPCODES.SHA3) {
        const off = Number(bigEndianBufToBigint(stackTop(lastStep.evmStack)))
        const len = Number(bigEndianBufToBigint(stackInd(lastStep.evmStack, 1)))
        const args = lastStep.memory.slice(off, off + len)
        const res = stackTop(state.evmStack);
        console.error(`KECCAK256(${bytesToHex(args)})=${bytesToHex(res)}`)
    }
    */

    // If there is no change to depth, then msg is the same as last step
    if (lastStep.depth === state.depth) {
        return {
            ...state,
            msg: lastStep.msg
        };
    }

    // Otherwise we must either be in a:
    // 1. New call context
    if (lastStep.callInfo) {
        const info = lastStep.callInfo;
        assert(!info.callToNoCodeAccount, `Shouldn't get here`);
        let newMsg: SolMessage;

        if (lastStep.op.opcode === OPCODES.CALL) {
            newMsg = lastStep.msg.call(info.gas, info.codeAddress, info.value, info.msgData);
        } else if (lastStep.op.opcode === OPCODES.STATICCALL) {
            newMsg = lastStep.msg.staticcall(info.gas, info.codeAddress, info.msgData);
        } else if (lastStep.op.opcode === OPCODES.DELEGATECALL) {
            newMsg = lastStep.msg.delegatecall(info.gas, info.codeAddress, info.msgData);
        } else {
            assert(
                lastStep.op.opcode === OPCODES.CALLCODE,
                `Unknown call opcode {0}`,
                lastStep.op.mnemonic
            );
            newMsg = lastStep.msg.callcode(info.gas, info.codeAddress, info.value, info.msgData);
        }

        return {
            ...state,
            msg: newMsg
        };
    }

    // 2. New contract creation context
    if (lastStep.createInfo) {
        const info = lastStep.createInfo;
        return {
            ...state,
            msg: lastStep.msg.create(info.value, info.salt, info.msgData, info.nonce)
        };
    }

    // 3. Returning from a context
    if (lastStep.returnInfo) {
        return {
            ...state,
            msg: trace[lastStep.returnInfo.correspCallIdx].msg
        };
    }

    // 4. Right after an exception
    assert(
        lastStep.exceptionInfo !== undefined && lastStep.exceptionInfo.correspCallIdx >= 0,
        `Unexpected change in depth at step ${trace.length}`
    );

    return {
        ...state,
        msg: trace[lastStep.exceptionInfo.correspCallIdx].msg
    };
}
