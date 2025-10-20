import { Address } from "@ethereumjs/util";
import {
    BaseMemoryView,
    Memory,
    Value as BaseValue,
    ImmMap,
    DefaultAllocator,
    ZERO_ADDRESS
} from "sol-dbg";
import { BaseScope, LocalsScope } from "./scope";
import {
    assert,
    FunctionDefinition,
    ModifierInvocation,
    VariableDeclaration
} from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Allocator } from "sol-dbg";
import { BuiltinFunction } from "./value";
import { ArtifactManager } from "./artifactManager";
import { AccountInfo } from "./chain";

export interface CallResult {
    reverted: boolean;
    data: Uint8Array;
    newContract?: Address;
}

export interface WorldInterface {
    create(msg: SolMessage): CallResult;
    call(msg: SolMessage): CallResult;
    staticcall(msg: SolMessage): CallResult;
    delegatecall(msg: SolMessage): CallResult;
    getAccount(address: string | Address): AccountInfo | undefined;
    setAccount(address: string | Address, account: AccountInfo): void;
    updateAccount(account: AccountInfo): void;
}

export interface SolMessage {
    from: Address;
    delegatingContract: Address | undefined;
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
    //Account of actual code executing. May be different from `account`s code for delegate calls
    codeAccount: AccountInfo | undefined;
    memory: Memory;
    memAllocator: Allocator;
    msg: SolMessage;
    intCallStack: InternalCallFrame[];
    scope: BaseScope | undefined;
    constantsMap: Map<number, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
}

/**
 * Built interpreter state without a contract present. Used for evaluating compile time constants only
 */
export function makeNoContractState(): State {
    const memAllocator = new DefaultAllocator();
    return {
        account: {
            address: ZERO_ADDRESS,
            contract: undefined,
            bytecode: new Uint8Array(),
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]),
            balance: 0n,
            nonce: 0n
        },
        codeAccount: undefined,
        memory: memAllocator.memory,
        memAllocator,
        msg: {
            from: ZERO_ADDRESS,
            to: ZERO_ADDRESS,
            delegatingContract: undefined,
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
export function makeStateForAccount(
    artifactManager: ArtifactManager,
    account: AccountInfo,
    codeAccount: AccountInfo | undefined
): State {
    const memAllocator = new DefaultAllocator();
    const contract = (codeAccount !== undefined ? codeAccount : account).contract;
    assert(contract !== undefined, ``);
    const [constantsMap, constantsMemory] = artifactManager.getConstants(contract.artifact);

    // Copy over the constants into the new memory
    memAllocator.alloc(constantsMemory.length);
    memAllocator.memory.set(constantsMemory, 0x80);

    return {
        account,
        codeAccount,
        memory: memAllocator.memory,
        memAllocator,
        msg: {
            from: ZERO_ADDRESS,
            to: ZERO_ADDRESS,
            delegatingContract: undefined,
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

export function makeStateWithConstants(
    artifactManager: ArtifactManager,
    contract: rtt.ContractInfo
): State {
    return makeStateForAccount(
        artifactManager,
        {
            address: ZERO_ADDRESS,
            contract,
            bytecode: new Uint8Array(),
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]),
            balance: 0n,
            nonce: 0n
        },
        undefined
    );
}
