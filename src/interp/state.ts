import { Address } from "@ethereumjs/util";
import {
    BaseMemoryView,
    Memory,
    Value as BaseValue,
    ImmMap,
    DefaultAllocator,
    ZERO_ADDRESS,
    ContractInfo
} from "sol-dbg";
import { BaseScope, LocalsScope } from "./scope";
import {
    FunctionDefinition,
    ModifierInvocation,
    TypeNode,
    VariableDeclaration
} from "solc-typed-ast";
import { Allocator } from "sol-dbg";
import { BuiltinFunction } from "./value";
import { ArtifactManager } from "./artifactManager";
import { AccountInfo } from "./chain";

export interface CallResult {
    reverted: boolean;
    data: Uint8Array;
}

export interface WorldInterface {
    create(msg: SolMessage): CallResult;
    call(msg: SolMessage): CallResult;
    staticcall(msg: SolMessage): CallResult;
    delegatecall(msg: SolMessage): CallResult;
    getAccount(address: string | Address): AccountInfo | undefined;
    setAccount(address: string | Address, account: AccountInfo): void;
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
    account: AccountInfo;
    memory: Memory;
    memAllocator: Allocator;
    msg: SolMessage;
    intCallStack: InternalCallFrame[];
    scope: BaseScope | undefined;
    constantsMap: Map<number, BaseMemoryView<BaseValue, TypeNode>>;
}

/**
 * Built interpreter state without a contract present. Used for evaluating compile time constants only
 */
export function makeNoContractState(): State {
    const memAllocator = new DefaultAllocator();
    return {
        account: {
            address: ZERO_ADDRESS,
            contract: undefined as unknown as any,
            storage: ImmMap.fromEntries([]),
            balance: 0n,
            nonce: 0n
        },
        memory: memAllocator.memory,
        memAllocator,
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
    contract: ContractInfo
): State {
    return makeStateForAccount(artifactManager, {
        address: ZERO_ADDRESS,
        contract,
        storage: ImmMap.fromEntries([]),
        balance: 0n,
        nonce: 0n
    });
}

export function makeStateForAccount(artifactManager: ArtifactManager, account: AccountInfo): State {
    const memAllocator = new DefaultAllocator();
    const [constantsMap, constantsMemory] = artifactManager.getConstants(account.contract.artifact);

    // Copy over the constants into the new memory
    memAllocator.alloc(constantsMemory.length);
    memAllocator.memory.set(constantsMemory, 0x80);

    return {
        account,
        memory: memAllocator.memory,
        memAllocator,
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
