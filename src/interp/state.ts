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
import { AccountInfo, SolMessage, SolMessageType } from "./env";
import { Block, createBlock } from "@ethereumjs/block";
import { createTx, TypedTransaction } from "@ethereumjs/tx";

export interface InternalCallFrame {
    callee: sol.FunctionDefinition | sol.VariableDeclaration | BuiltinFunction;
    scope: LocalsScope;
    curModifier: sol.ModifierInvocation | undefined;
}

/**
 * Interpreter runtime state.
 * 
 * Contains all the necessary information to invoke a call, deploy a contract, execute a statement, or evaluate an expression by the interpreter.
 */
export interface State {
    // Account info for the currently executing account
    account: AccountInfo;
    // Account info of actual code executing. Is defined only for delegate calls
    codeAccount: AccountInfo | undefined;
    // Scratch space for the deployed bytecode being created inside the constructor
    partialDeployedBytecode: Uint8Array | undefined;
    // The current memory
    memory: Memory;
    // The current memory allocator. The default allocator works the same way as Solidity compiled allocation as of 0.8.29
    memAllocator: Allocator;
    // The `SolMessage` for the current execution context
    msg: SolMessage;
    // Internal call-stack. Contains the values of all local variables on the call stack
    intCallStack: InternalCallFrame[];
    // Current  *syntactic* scope being evaluated. Each scope contains a pointer to its parent scope for symbol resolution
    scope: BaseScope | undefined;
    // Helper map from constant strings/constants vars to their values in memory
    constantsMap: Map<number, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
    // Flag whether the current context is a STATICCALL (i.e. state is readonly)
    storageReadOnly: boolean;
    // Current block
    block: Block;
    // Current root TX
    tx: TypedTransaction;
    // Whether the current State is built only for a compile-time constant evaluation pass
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
        msg: SolMessage.constantEvalMessage(),
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
    msg: SolMessage
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
        msg,
        intCallStack: [],
        scope: undefined,
        constantsMap: constantsMap,
        storageReadOnly: msg.type === SolMessageType.STATICCALL,
        block: createBlock(),
        tx: createTx({}),
        isConstantsEval: false
    };
}

export function makeTestStateWithConstants(
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
        SolMessage.constantEvalMessage()
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
    scopes: ImmMap<number, Value>;
    constantsMap: Map<number, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
    storageReadOnly: boolean;
    block: Block;
    tx: TypedTransaction;
}

function takeScopeSnapshot(scope: BaseScope): ImmMap<number, Value> {
    const localEntries: Array<[number, Value]> = [];
    for (const [decl] of scope.knownIdentifiers) {
        const val = scope.lookup(decl);
        sol.assert(val !== undefined, ``);

        localEntries.push([decl.id, val]);
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
