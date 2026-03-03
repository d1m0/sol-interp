import {
    BaseMemoryView,
    Memory,
    Value as BaseValue,
    ImmMap,
    DefaultAllocator,
    ZERO_ADDRESS
} from "sol-dbg";
import { BaseScope, LocalsScope } from "./scope";
import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Allocator } from "sol-dbg";
import { BuiltinFunction } from "./value";
import { ArtifactManager } from "./artifactManager";
import { AccountInfo, SolMessage } from "./env";

export interface InternalCallFrame {
    callee: sol.FunctionDefinition | sol.VariableDeclaration | BuiltinFunction;
    scope: LocalsScope;
    curModifier: sol.ModifierInvocation | undefined;
}

export interface State {
    //Solidity version of the current contract
    account: AccountInfo;
    //Account of actual code executing. May be different from `account`s code for delegate calls
    codeAccount: AccountInfo | undefined;
    //Scratch space for the deployed bytecode being created inside the constructor
    partialDeployedBytecode: Uint8Array | undefined;
    memory: Memory;
    memAllocator: Allocator;
    msg: SolMessage;
    intCallStack: InternalCallFrame[];
    scope: BaseScope | undefined;
    constantsMap: Map<number, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
    storageReadOnly: boolean;
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
        partialDeployedBytecode: undefined,
        memory: memAllocator.memory,
        memAllocator,
        msg: {
            from: ZERO_ADDRESS,
            to: ZERO_ADDRESS,
            delegatingContract: undefined,
            data: new Uint8Array(),
            gas: 0n,
            value: 0n,
            salt: undefined,
            isStaticCall: false,
            depth: 0
        },
        intCallStack: [],
        scope: undefined,
        constantsMap: new Map(),
        storageReadOnly: true
    };
}

/**
 * Make an empty state containing just the constants
 * @returns
 */
export function makeStateForAccount(
    artifactManager: ArtifactManager,
    account: AccountInfo,
    codeAccount: AccountInfo | undefined,
    storageReadOnly: boolean
): State {
    const memAllocator = new DefaultAllocator();
    const contract = (codeAccount !== undefined ? codeAccount : account).contract;
    sol.assert(contract !== undefined, ``);
    const [constantsMap, constantsMemory] = artifactManager.getConstants(contract.artifact);

    // Copy over the constants into the new memory
    memAllocator.alloc(constantsMemory.length);
    memAllocator.memory.set(constantsMemory, 0x80);

    return {
        account,
        codeAccount,
        partialDeployedBytecode: undefined,
        memory: memAllocator.memory,
        memAllocator,
        msg: {
            from: ZERO_ADDRESS,
            to: ZERO_ADDRESS,
            delegatingContract: undefined,
            data: new Uint8Array(),
            gas: 0n,
            value: 0n,
            salt: undefined,
            isStaticCall: false,
            depth: 0
        },
        intCallStack: [],
        scope: undefined,
        constantsMap: constantsMap,
        storageReadOnly
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
        undefined,
        false
    );
}
