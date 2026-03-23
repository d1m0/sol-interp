import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, OPCODES, OpInfo, ZERO_ADDRESS } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { WithCreateInfo } from "./create";
import { WithCallInfo } from "./call";
import { WithExceptionInfo } from "./exceptions";
import { ReturnInfo, WithReturnInfo } from "./return";
import { TypedTransaction } from "@ethereumjs/tx";

export interface CodeInfo {
    // Currently executing bytecode in this call context.
    // Note: For creation bytecodes we will also have the constructor args as garbage in the end here.
    code: Uint8Array;
    // True IFF the current call context is a contract creation bytecode
    isCreation: boolean;
    // True IFF the current call context is a delegate call
    isDelegated: boolean;
    // True IFF the current call context is a static call
    isStatic: boolean;
}
export interface WithCodeInfo {
    codeInfo: CodeInfo;
}

type LowerStep = BasicStepInfo &
    OpInfo &
    WithCreateInfo &
    WithCallInfo &
    WithExceptionInfo &
    WithReturnInfo;

/**
 * Adds deployment info for steps that are about to deploy a contract
 */
export async function addCodeInfo<T extends object & LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithCodeInfo>,
    tx: TypedTransaction
): Promise<T & WithCodeInfo> {
    const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;

    if (lastStep === undefined) {
        const isCreation = tx.to === undefined || tx.to.equals(ZERO_ADDRESS);
        const code = isCreation ? tx.data : await vm.stateManager.getCode(tx.to);
        return {
            ...state,
            codeInfo: {
                code,
                isCreation,
                isDelegated: false,
                isStatic: false
            }
        };
    }

    if (lastStep.createInfo && lastStep.exceptionInfo === undefined) {
        return {
            ...state,
            codeInfo: {
                code: lastStep.createInfo.msgData,
                isCreation: true,
                isDelegated: false,
                isStatic: false
            }
        };
    }

    // The condition step.depth > lastStep.depth is to handle calls to contracts with no code.
    if (lastStep.callInfo && lastStep.exceptionInfo === undefined && state.depth > lastStep.depth) {
        return {
            ...state,
            codeInfo: {
                code: await vm.stateManager.getCode(lastStep.callInfo.address),
                isCreation: false,
                isDelegated:
                    lastStep.op.opcode === OPCODES.DELEGATECALL ||
                    lastStep.op.opcode === OPCODES.CALLCODE,
                isStatic: lastStep.op.opcode === OPCODES.STATICCALL
            }
        };
    }

    if (lastStep.returnInfo || lastStep.exceptionInfo) {
        const callIdx = lastStep.exceptionInfo
            ? lastStep.exceptionInfo.correspCallIdx
            : (lastStep.returnInfo as ReturnInfo).correspCallIdx;
        return {
            ...state,
            codeInfo: trace[callIdx].codeInfo
        };
    }

    return {
        ...state,
        codeInfo: lastStep.codeInfo
    };
}
