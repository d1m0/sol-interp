import { StateManagerInterface } from "@ethereumjs/common";
import { InterpreterStep } from "@ethereumjs/evm";
import { RLP } from "@ethereumjs/rlp";
import { Address, bytesToBigInt, setLengthLeft } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { hexToBytes } from "ethereum-cryptography/utils";
import { assert } from "solc-typed-ast";
import { MerkleStateManager } from "@ethereumjs/statemanager";
import {
    bigIntToBuf,
    changesMemory,
    EVMOpInfo,
    ImmMap,
    Memory,
    OPCODES,
    OpInfo,
    Stack,
    stackTop,
    Storage
} from "sol-dbg";
import { isCall } from "../utils";

export async function getStorage(manager: StateManagerInterface, addr: Address): Promise<Storage> {
    const rawStorage = await (manager as MerkleStateManager).dumpStorage(addr);
    const storageEntries: Array<[bigint, Uint8Array]> = [];

    for (const [keyStr, valStr] of Object.entries(rawStorage)) {
        const decoded = RLP.decode(hexToBytes(valStr));
        assert(decoded instanceof Uint8Array, "");
        const valBuf = setLengthLeft(decoded, 32);

        storageEntries.push([BigInt(keyStr), valBuf]);
    }

    return ImmMap.fromEntries(storageEntries);
}

export interface BasicStepInfo {
    evmStack: Stack;
    memory: Memory;
    storage: Storage;
    op: EVMOpInfo;
    pc: number;
    gasCost: bigint;
    dynamicGasCost: bigint;
    gas: bigint;
    depth: number;
    address: Address;
    codeAddress: Address;
}

function storageChanged<T extends object & OpInfo>(
    lastStep: (T & BasicStepInfo) | undefined,
    step: InterpreterStep
): boolean {
    if (lastStep === undefined) {
        return true;
    }

    if (lastStep.depth !== step.depth + 1) {
        return true;
    }

    if (lastStep.op.opcode === OPCODES.SSTORE) {
        return true;
    }

    return false;
}

function memoryChanged<T extends object & OpInfo>(
    lastStep: (T & BasicStepInfo) | undefined,
    step: InterpreterStep
): boolean {
    if (lastStep === undefined) {
        return true;
    }

    if (lastStep.depth !== step.depth + 1) {
        return true;
    }

    if (changesMemory(lastStep.op)) {
        return true;
    }

    // Calls to precompiles may change memory
    if (isCall(lastStep) && lastStep.depth === step.depth + 1) {
        return true;
    }

    // Loads past the end of memory implicitly increase memory
    if (lastStep.op.opcode === OPCODES.MLOAD) {
        const off = bytesToBigInt(stackTop(lastStep.evmStack));
        if (off + 32n > BigInt(lastStep.memory.length)) {
            return true;
        }
    }

    // Implicit reads past the end of memory resulting in additional 0s appended
    if (step.memory.length !== lastStep.memory.length) {
        return true;
    }

    return false;
}

type LowerStep = object & OpInfo;

/**
 * Adds cleaner typed version of the low-level debugging information
 */
export async function addBasicInfo<T extends LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & BasicStepInfo>
): Promise<T & BasicStepInfo> {
    const evmStack = step.stack.map((word) => bigIntToBuf(word, 32, "big"));
    const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;

    const memory: Memory = memoryChanged(lastStep, step)
        ? new Uint8Array(step.memory)
        : (lastStep as T & BasicStepInfo).memory;

    let storage: Storage;

    if (storageChanged(lastStep, step)) {
        /** @todo the way we use getStorage we dont take advantage of ImmMap! This is inefficient */
        storage = await getStorage(vm.stateManager, step.address);
    } else {
        storage = (lastStep as T & BasicStepInfo).storage;
    }

    const gasCost = BigInt(step.opcode.fee);
    const dynamicGasCost = step.opcode.dynamicFee === undefined ? gasCost : step.opcode.dynamicFee;

    return {
        evmStack,
        memory,
        storage,
        ...state,
        pc: step.pc,
        gasCost,
        dynamicGasCost,
        gas: step.gasLeft,
        depth: step.depth + 1,
        address: step.address,
        codeAddress: step.codeAddress
    };
}
