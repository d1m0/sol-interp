import { Address } from "@ethereumjs/util";
import {
    BaseMemoryView,
    Memory,
    Storage,
    Value as BaseValue,
    ImmMap,
    DefaultAllocator,
    ZERO_ADDRESS,
    ContractInfo,
    ArtifactInfo
} from "sol-dbg";
import { BaseScope, LocalsScope } from "./scope";
import {
    ContractDefinition,
    FunctionDefinition,
    ModifierInvocation,
    TypeNode,
    VariableDeclaration
} from "solc-typed-ast";
import { Allocator } from "sol-dbg";
import { BuiltinFunction } from "./value";
import { ArtifactManager } from "./artifactManager";

export interface CallResult {
    reverted: boolean;
    data: Uint8Array;
}

export interface WorldInterface {
    create(msg: SolMessage): Promise<CallResult>;
    call(msg: SolMessage): Promise<CallResult>;
    staticcall(msg: SolMessage): Promise<CallResult>;
    delegatecall(msg: SolMessage): Promise<CallResult>;
    getStorage(): Storage;
}

export interface SolMessage {
    to: Address;
    data: Uint8Array;
    gas: bigint;
    value: bigint;
    salt: Uint8Array | undefined;
}

export interface InternalCallFrame {
    callee: FunctionDefinition | VariableDeclaration | BuiltinFunction;
    scope: LocalsScope;
    curModifier: ModifierInvocation | undefined;
}

export interface State {
    //Solidity version of the current contract
    storage: Storage;
    memory: Memory;
    memAllocator: Allocator;
    contract: ContractInfo | undefined;
    mdc: ContractDefinition | undefined;
    msg: SolMessage;
    intCallStack: InternalCallFrame[];
    scope: BaseScope | undefined;
    constantsMap: Map<number, BaseMemoryView<BaseValue, TypeNode>>;
}

export function makeEmptyState(): State {
    const memAllocator = new DefaultAllocator();
    return {
        storage: ImmMap.fromEntries([]),
        memory: memAllocator.memory,
        memAllocator,
        contract: undefined,
        mdc: undefined,
        msg: {
            to: ZERO_ADDRESS,
            data: new Uint8Array(),
            gas: 0n,
            value: 0n,
            salt: undefined
        },
        intCallStack: [],
        scope: undefined,
        constantsMap: new Map()
    };
}

/**
 * Make an empty state containing just the constants
 * @returns
 */
export function makeStateWithConstants(
    artifactManager: ArtifactManager,
    artifact: ArtifactInfo
): State {
    const memAllocator = new DefaultAllocator();
    const [constantsMap, constantsMemory] = artifactManager.getConstants(artifact);

    // Copy over the constants into the new memory
    memAllocator.alloc(constantsMemory.length);
    memAllocator.memory.set(constantsMemory, 0x80);

    return {
        storage: ImmMap.fromEntries([]),
        memory: memAllocator.memory,
        memAllocator,
        mdc: undefined,
        contract: undefined,
        msg: {
            to: ZERO_ADDRESS,
            data: new Uint8Array(),
            gas: 0n,
            value: 0n,
            salt: undefined
        },
        intCallStack: [],
        scope: undefined,
        constantsMap: constantsMap
    };
}
