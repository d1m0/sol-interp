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
import { BuiltinFunction, Value } from "./value";
import { ArtifactManager } from "./artifactManager";
import { AccountInfo, SolMessage } from "./env";
import { Block, createBlock } from "@ethereumjs/block";
import { createTx, TypedTransaction } from "@ethereumjs/tx";

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
    block: Block;
    tx: TypedTransaction;
    isConstantsEval: boolean;
}

/**
 * Built interpreter state without a contract present. Used for evaluating compile time constants only
 */
export function makeConstantsEvalState(): State {
    const memAllocator = new DefaultAllocator();
    return {
        account: {
            address: ZERO_ADDRESS,
            contract: undefined,
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
        storageReadOnly: true,
        block: createBlock(),
        tx: createTx({}),
        isConstantsEval: true
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
        storageReadOnly,
        block: createBlock(),
        tx: createTx({}),
        isConstantsEval: false
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
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]),
            balance: 0n,
            nonce: 0n
        },
        undefined,
        false
    );
}

/**
 * Snapshot of the current state that can be attached to a trace step.
 * @todo: This is very unoptimized, and wastes a lot of memory due to unnecessary repetion
 * of storage, memory and scopes. We need a better data structure here.
 */
export interface StateSnapshot {
    account: AccountInfo;
    codeAccount: AccountInfo | undefined;
    partialDeployedBytecode: Uint8Array | undefined;
    memory: Memory;
    scopes: ImmMap<string, Value>;
    constantsMap: Map<number, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
    storageReadOnly: boolean;
    block: Block;
    tx: TypedTransaction;
}

function takeScopeSnapshot(scope: BaseScope): ImmMap<string, Value> {
    const localEntries: Array<[string, Value]> = [];
    for (const [decl, val] of scope.knownIdentifiers) {
        let name: string;
        if (decl.name === "") {
            // Unnamed return
            const parent = decl.parent;
            sol.assert(parent instanceof sol.ParameterList, `Only a return decl can be unnamed`);
            const retIdx = parent.vParameters.indexOf(decl);
            sol.assert(retIdx >= 0, `Only a return decl can be unnamed`);
            name = `RET_${retIdx}`;
        } else {
            name = decl.name;
        }

        localEntries.push([name, val]);
    }

    if (scope._next === undefined) {
        return ImmMap.fromEntries(localEntries);
    }

    const nextScopeSnapshot = takeScopeSnapshot(scope._next);
    return nextScopeSnapshot.setMany(localEntries);
}

export function takeStateSnapshot(state: State): StateSnapshot {
    sol.assert(state.scope !== undefined, `Unexpected snapshot of state with no scope`);
    sol.assert(!state.isConstantsEval, `Unexpected snapshot of constants evaluation.`);
    return {
        // account and code account hold an immutable snapshot of the current storage
        account: {
            ...state.account
        },
        codeAccount:
            state.codeAccount === undefined
                ? undefined
                : {
                      ...state.codeAccount
                  },
        // Note that we need a copy here to show the gradual filling in of immutables during constructor execution
        partialDeployedBytecode:
            state.partialDeployedBytecode === undefined
                ? undefined
                : new Uint8Array(state.partialDeployedBytecode),
        memory: new Uint8Array(state.memory),
        scopes: takeScopeSnapshot(state.scope),
        // This doesn't change during a normal trace (we don't take snapshot during constant evaluation)
        constantsMap: state.constantsMap,
        // This doesn't change during a normal trace
        block: state.block,
        // This doesn't change during a normal trace
        tx: state.tx,
        storageReadOnly: state.storageReadOnly
    };
}
