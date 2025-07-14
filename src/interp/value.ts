import {
    Value as BaseValue,
    ExternalFunRef,
    InternalFunRef,
    Poison,
    PrimitiveValue,
    Slice
} from "sol-dbg";
import { StateArea, View } from "sol-dbg";
import { BuiltinFunctionType, TypeNode } from "solc-typed-ast";
import { State } from "./state";
import { Address } from "@ethereumjs/util";

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

export type Value = PrimitiveValue | BuiltinFunction | BuiltinStruct | Value[];
export type LValue =
    | View<StateArea, BaseValue, any, TypeNode>
    | null // empty components of tuple assignments
    | LValue[]; // Tuple assignments

// @todo move to sol-dbg
export function isPrimitiveValue(v: any): v is PrimitiveValue {
    return (
        typeof v === "bigint" ||
        typeof v === "boolean" ||
        v instanceof Uint8Array ||
        v instanceof Address ||
        v instanceof ExternalFunRef ||
        v instanceof InternalFunRef ||
        v instanceof Slice ||
        v instanceof View ||
        v instanceof Poison
    );
}
