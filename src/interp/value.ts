import { Value as BaseValue, Poison } from "sol-dbg/dist/debug/decoding/value";
import { StateArea, View } from "sol-dbg/dist/debug/decoding/view";
import { FunctionType, NamedDefinition, TypeNode } from "solc-typed-ast";
import { BaseScope } from "./scope";

export abstract class BuiltinFunction {
    constructor(
        public readonly name: string,
        public readonly type: FunctionType
    ) {}

    abstract call(...args: Value[]): Value[];
}

export class UserDefinition {
    constructor(
        public readonly name: string,
        public readonly definition: NamedDefinition
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
 */
export class NoneValue extends Poison {
    pp(): string {
        return "<none>";
    }
}

export type Value = BaseValue | BuiltinFunction | UserDefinition | BuiltinStruct | Value[];
export type LValue = View<StateArea, BaseValue, any, TypeNode> | [BaseScope, string]
