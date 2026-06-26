import { VM } from "@ethereumjs/vm";
import { bigEndianBufToNumber, mustReadMem, OPCODES, OpInfo } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { isOutOfGas } from "../utils";
import { TracerContext } from "../tracer";
import { WithReturnInfo } from "./return";
import { BasicStepInfo } from "./basic_info";

export enum ExceptionType {
    Revert = 0,
    Assert = 1,
    OutOfGas = 2,
    Other = 3
}
/**
 * Interface with additional data regarding a RETURN/STOP op
 */
export interface ExceptionInfo {
    // Exception bytes
    excData: Uint8Array;
    // The type of exception. See ExceptionTypes for details
    type: ExceptionType;
    // Index of the corresponding *CALL*/CREATE* instruction to whom's context we are reverting
    // -1 for top-level reverts
    correspCallIdx: number;
}

export interface WithExceptionInfo {
    exceptionInfo: ExceptionInfo | undefined;
}

type LowerStep = object & BasicStepInfo & OpInfo & WithReturnInfo;

/**
 * If the *previous* step in the trace caused an exception
 */
export async function addExceptionInfo<T extends LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithExceptionInfo>,
    ctx: TracerContext
): Promise<T & WithExceptionInfo> {
    const correspCallIdx = state.callFrame.callOpStepIdx;

    // Explicit revert
    if (state.op.opcode === OPCODES.REVERT) {
        const stackTop = state.evmStack.length - 1;
        const start = bigEndianBufToNumber(state.evmStack[stackTop]);
        const size = bigEndianBufToNumber(state.evmStack[stackTop - 1]);
        const excData = size === 0 ? new Uint8Array() : mustReadMem(start, size, state.memory);

        ctx.callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData,
                type: ExceptionType.Revert,
                correspCallIdx
            }
        };
    }

    // Explicit invalid excepetion (old-style assert)
    if (!state.op.valid) {
        ctx.callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData: new Uint8Array(),
                type: ExceptionType.Assert,
                correspCallIdx
            }
        };
    }

    // Out-of-gas
    if (isOutOfGas(state)) {
        ctx.callStack.pop();
        return {
            ...state,
            exceptionInfo: {
                excData: new Uint8Array(),
                type: ExceptionType.OutOfGas,
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
        lastStep.returnInfo !== undefined ||
        lastStep.exceptionInfo !== undefined
    ) {
        return {
            ...state,
            exceptionInfo: undefined
        };
    }

    lastStep.exceptionInfo = {
        excData: new Uint8Array(),
        type: ExceptionType.Other,
        correspCallIdx
    };

    ctx.callStack.pop();
    return {
        ...state,
        exceptionInfo: undefined
    };
}
