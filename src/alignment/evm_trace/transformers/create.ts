import { StateManagerInterface } from "@ethereumjs/common";
import { TypedTransaction } from "@ethereumjs/tx";
import { Address } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, OpInfo, IArtifactManager, OPCODES } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";

/**
 * Interface with additional data regarding a CREATE/CREATE2 op
 */
export interface CreateInfo {
    address: Address; // New contract address to be created
    value: bigint | undefined; // value sent. undefined for staticcall
    msgData: Uint8Array; // msg data
    salt: Uint8Array | undefined
    nonce: bigint; // caller nonce
    state: StateManagerInterface; // copy of the state before the call instruction executes
}

interface WithCreateInfo {
    createInfo: CreateInfo | undefined;
}

/**
 * Adds external frame info for each step
 */
export async function addCreateInfo<T extends object & BasicStepInfo & OpInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithCreateInfo>,
    artifactManager: IArtifactManager,
    tx: TypedTransaction
): Promise<T & WithCreateInfo> {
    const op = state.op;

    if (op.opcode !== OPCODES.CREATE && op.opcode !== OPCODES.CREATE2) {
        return {
            ...state,
            createInfo: undefined
        }
    }
}