import { Value as BaseValue, Poison } from "sol-dbg/dist/debug/decoding/value";
import { StateArea, View } from "sol-dbg/dist/debug/decoding/view";
import { BuiltinFunctionType, NamedDefinition, TypeNode } from "solc-typed-ast";
import { BaseScope } from "./scope";
import { State } from "./state";

export class BuiltinFunction {
    constructor(
        public readonly name: string,
        public readonly type: BuiltinFunctionType,
        public readonly call: (state: State, args: Value[]) => Value[]
    ) {}
}

export class BuiltinStruct {
    constructor(
        public readonly name: string,
        public readonly fields: Array<[string, Value]>
    ) {}
}

/**
 * Value corresponding to evaluating:
 * 1. Missing component in a tuple - e.g. (1,,2)
 * 2. The empty tuple - ()
 * 3. The return of a void function
 * 4. Initial value of an uninitialized pointer local variable
 */
export class NoneValue extends Poison {
    pp(): string {
        return "<none>";
    }
}

export const none = new NoneValue();

export interface LocalScopeView {
    scope: BaseScope,
    name: string
}

export function isLocalScopeView(a: any): a is LocalScopeView {
    return a instanceof Object && "scope" in a && "name" in a;
}

export type Value = BaseValue | BuiltinFunction | NamedDefinition | BuiltinStruct | Value[];
export type LValue
    = View<StateArea, BaseValue, any, TypeNode>
    | LocalScopeView 
    | null // empty components of tuple assignments
    | LValue[]; // Tuple assignments
