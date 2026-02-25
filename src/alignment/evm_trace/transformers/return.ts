import { StateManagerInterface } from "@ethereumjs/common";
import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, OpInfo, OPCODES, bigEndianBufToNumber, mustReadMem } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";

/**
 * Interface with additional data regarding a RETURN/STOP op
 */
export interface ReturnInfo {
    retData: Uint8Array; // return data
    state: StateManagerInterface; // copy of the state before the return instruction executes
}

interface WithReturnInfo {
    returnInfo: ReturnInfo | undefined
}

/**
 * Adds return info for steps that are about to return from the current context
 */
export async function addReturnInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
): Promise<T & WithReturnInfo> {
    const op = state.op;

    if (op.opcode !== OPCODES.STOP && op.opcode !== OPCODES.RETURN) {
        return {
            ...state,
            returnInfo: undefined
        }
    }

    const stateManager = vm.stateManager.shallowCopy();

    if (op.opcode === OPCODES.STOP) {
        return {
            ...state,
            returnInfo: {
                retData: new Uint8Array(),
                state: stateManager
            }
        }
    }

    const stackTop = state.evmStack.length - 1;
    const start = bigEndianBufToNumber(state.evmStack[stackTop]);
    const size = bigEndianBufToNumber(state.evmStack[stackTop - 1]);
    const retData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

    return {
        ...state,
        returnInfo: {
            retData,
            state: stateManager
        }
    }
}