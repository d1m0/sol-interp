import { Address } from "@ethereumjs/util";
import { Memory, Storage } from "sol-dbg";
import { BaseScope } from "./scope";
import { FunctionDefinition, VariableDeclaration } from "solc-typed-ast";
import { Value } from "./value";

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
    callee: FunctionDefinition | VariableDeclaration
    args: Value[]
}

export interface State {
    version: string
    storage: Storage,
    memory: Memory,
    extCallStack: SolMessage[]
    intCallStack: InternalCallFrame[]
    localsStack: Map<string, Value>[]
    scope: BaseScope | undefined
}