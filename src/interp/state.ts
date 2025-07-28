import { Address } from "@ethereumjs/util";
import {
    BaseMemoryView,
    Memory,
    Storage,
    Value as BaseValue,
    ImmMap,
    DefaultAllocator,
    ZERO_ADDRESS
} from "sol-dbg";
import { BaseScope } from "./scope";
import {
    ContractDefinition,
    FunctionDefinition,
    TypeNode,
    VariableDeclaration
} from "solc-typed-ast";
import { Value } from "./value";
import { Allocator } from "sol-dbg";

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
    callee: FunctionDefinition | VariableDeclaration;
    args: Value[];
}

export interface State {
    //Solidity version of the current contract
    version: string;
    storage: Storage;
    memory: Memory;
    memAllocator: Allocator;
    mdc: ContractDefinition | undefined;
    msg: SolMessage;
    intCallStack: InternalCallFrame[];
    scope: BaseScope | undefined;
    constantsMap: Map<number, BaseMemoryView<BaseValue, TypeNode>>;
}

export function makeEmptyState(version: string): State {
    const memAllocator = new DefaultAllocator();
    return {
        version,
        storage: ImmMap.fromEntries([]),
        memory: memAllocator.memory,
        memAllocator,
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
