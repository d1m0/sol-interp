import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    OpInfo,
    OPCODES,
    bigEndianBufToNumber,
    mustReadMem,
    InstructionControlFlow
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { Address } from "@ethereumjs/util";
import { TracerContext } from "../tracer";
import { WithCallInfo } from "./call";

/**
 * Interface with additional data regarding a RETURN/STOP op
 */
export interface ReturnInfo {
    retData: Uint8Array; // return data
    newContract?: Address;
    // Index of the corresponding *CALL*/CREATE* instruction to whom's context we are reverting
    // -1 for top-level reverts
    correspCallIdx: number;
}

export interface WithReturnInfo {
    returnInfo: ReturnInfo | undefined;
}

type LowerStep = object & BasicStepInfo & OpInfo & WithCallInfo;

/**
 * Adds return info for steps that are about to return from the current context
 */
export async function addReturnInfo<T extends LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithReturnInfo>,
    ctx: TracerContext
): Promise<T & WithReturnInfo> {
    const op = state.op;
    const idx = state.callFrame.callOpStepIdx;
    const newContract = state.callFrame.msg.isCreation() ? state.address : undefined;

    const code = state.callFrame.code;

    // Executing past the end of the code is equivalent to a STOP for any instruction
    if (
        state.pc === code.length - 1 &&
        state.op.controlFlow === InstructionControlFlow.NextInstruction
    ) {
        ctx.callStack.pop();
        return {
            ...state,
            returnInfo: {
                retData: new Uint8Array(),
                newContract,
                correspCallIdx: idx
            }
        };
    }

    if (
        op.opcode !== OPCODES.STOP &&
        op.opcode !== OPCODES.RETURN &&
        op.opcode !== OPCODES.SELFDESTRUCT
    ) {
        return {
            ...state,
            returnInfo: undefined
        };
    }

    ctx.callStack.pop();

    if (
        op.opcode === OPCODES.STOP
    ) {
        return {
            ...state,
            returnInfo: {
                retData: new Uint8Array(),
                newContract,
                correspCallIdx: idx
            }
        };
    }

    if (op.opcode === OPCODES.SELFDESTRUCT) {
        return {
            ...state,
            returnInfo: {
                retData: new Uint8Array(),
                newContract: undefined,
                correspCallIdx: idx
            }
        };
    }

    const stackTop = state.evmStack.length - 1;
    const start = bigEndianBufToNumber(state.evmStack[stackTop]);
    const size = bigEndianBufToNumber(state.evmStack[stackTop - 1]);
    const retData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    return {
        ...state,
        returnInfo: {
            retData,
            newContract,
            correspCallIdx: idx
        }
    };
}
