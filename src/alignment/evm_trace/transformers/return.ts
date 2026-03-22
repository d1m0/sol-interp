import { StorageDump } from "@ethereumjs/common";
import { VM } from "@ethereumjs/vm";
import {
    BasicStepInfo,
    OpInfo,
    OPCODES,
    bigEndianBufToNumber,
    mustReadMem,
    ZERO_ADDRESS
} from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { Address } from "@ethereumjs/util";
import { isCreate } from "../utils";
import { TypedTransaction } from "@ethereumjs/tx";
import { assert } from "../../../utils";

/**
 * Interface with additional data regarding a RETURN/STOP op
 */
export interface ReturnInfo {
    retData: Uint8Array; // return data
    state: StorageDump; // copy of the state before the return instruction executes
    newContract?: Address;
    // Index of the corresponding *CALL*/CREATE* instruction to whom's context we are reverting
    // -1 for top-level reverts
    correspCallIdx: number;
}

export interface WithReturnInfo {
    returnInfo: ReturnInfo | undefined;
}

/**
 * Adds return info for steps that are about to return from the current context
 */
export async function addReturnInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithReturnInfo>,
    callStack: number[],
    tx: TypedTransaction
): Promise<T & WithReturnInfo> {
    const op = state.op;

    if (op.opcode !== OPCODES.STOP && op.opcode !== OPCODES.RETURN) {
        return {
            ...state,
            returnInfo: undefined
        };
    }

    const idx = callStack.pop();
    assert(idx !== undefined, ``);
    const isCreation =
        (idx > 0 && isCreate(trace[idx])) ||
        (idx < 0 && (tx.to === undefined || tx.to.equals(ZERO_ADDRESS)));

    const storageDump = await (vm.stateManager.dumpStorage as any)(step.address);

    if (op.opcode === OPCODES.STOP) {
        return {
            ...state,
            returnInfo: {
                retData: new Uint8Array(),
                state: storageDump,
                newContract: isCreation ? state.address : undefined,
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
            state: storageDump,
            newContract: isCreation ? state.address : undefined,
            correspCallIdx: idx
        }
    };
}
