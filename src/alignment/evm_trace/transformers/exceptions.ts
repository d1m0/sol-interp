import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, bigEndianBufToNumber, mustReadMem, OPCODES, OpInfo } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { isOutOfGas, isNonExceptionTermination } from "../utils";

/**
 * Interface with additional data regarding a RETURN/STOP op
 */
export interface ExceptionInfo {
    // Exception bytes
    excData: Uint8Array;
    // True if this is an exception raised by REVERT/INVALID
    isExplicit: boolean;
    // Index of the corresponding *CALL*/CREATE* instruction to whom's context we are reverting
    // -1 for top-level reverts
    correspCallIdx: number;
}

export interface WithExceptionInfo {
    exceptionInfo: ExceptionInfo | undefined;
}

/**
 * If the *previous* step in the trace caused an exception
 */
export async function addExceptionInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithExceptionInfo>,
    callStack: number[]
): Promise<T & WithExceptionInfo> {
    const correspCallIdx = callStack[callStack.length - 1];

    // Explicit revert
    if (state.op.opcode === OPCODES.REVERT) {
        const stackTop = state.evmStack.length - 1;
        const start = bigEndianBufToNumber(state.evmStack[stackTop]);
        const size = bigEndianBufToNumber(state.evmStack[stackTop - 1]);
        const excData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

        callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData,
                isExplicit: true,
                correspCallIdx
            }
        };
    }

    // Explicit invalid excepetion (old-style assert)
    if (!state.op.valid) {
        callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData: new Uint8Array(),
                isExplicit: true,
                correspCallIdx
            }
        };
    }

    // Out-of-gas
    if (isOutOfGas(state)) {
        callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData: new Uint8Array(),
                isExplicit: false,
                correspCallIdx
            }
        };
    }

    /**
     * There are other possible implicit exceptions:
     *  - stack over/under flow
     *  - other misc exceptions (e.g. see RETURNDATACOPY)
     *
     * Instead of trying to track each case separately, we use the following simple algorithm:
     *
     * On the N-th instruction:
     *  1) if depth of N is < depth of N-1
     *  2) N-1 is not a RETURN/STOP
     *
     * Then an implicit exception occured on instruction N-1.
     *
     * Note that destrictively modifying an instruction back in the trace is stricly speaking breaking the map/reduce logic,
     * but as long as no other transformer relies on the correctness of exception info, it should be safe.
     *
     * Also this requires extra post-processing for the last instruction in the trace.
     */

    if (trace.length === 0) {
        return {
            ...state,
            exceptionInfo: undefined
        };
    }

    const lastStep = trace[trace.length - 1];

    if (
        lastStep.depth <= state.depth ||
        isNonExceptionTermination(lastStep) ||
        lastStep.exceptionInfo !== undefined
    ) {
        return {
            ...state,
            exceptionInfo: undefined
        };
    }

    lastStep.exceptionInfo = {
        excData: new Uint8Array(),
        isExplicit: false,
        correspCallIdx
    };

    callStack.pop();
    return {
        ...state,
        exceptionInfo: undefined
    };
}
