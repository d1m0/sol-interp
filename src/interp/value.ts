import {
    Value as BaseValue,
    ExternalFunRef,
    FunctionValue,
    InternalFunRef,
    nyi,
    Poison,
    PrimitiveValue,
    Slice
} from "sol-dbg";
import { StateArea, View } from "sol-dbg";
import * as sol from "solc-typed-ast"
import { State } from "./state";
import { Address } from "@ethereumjs/util";
import { Interpreter } from "./interp";

export abstract class BaseInterpValue implements sol.PPAble {
    abstract pp(): string;
}

export class BuiltinFunction extends BaseInterpValue {
    constructor(
        public readonly name: string,
        public readonly type: sol.BuiltinFunctionType,
        public readonly call: (interp: Interpreter, state: State, args: Value[]) => Value[]
    ) { super(); }

    pp(): string {
        return `<builtin fun ${this.type.pp()}>`
    }
}

export class BuiltinStruct extends BaseInterpValue {
    constructor(
        public readonly name: string,
        public readonly fields: Array<[string, Value]>
    ) { super(); }

    pp(): string {
        return `<builtin struct ${this.name}>`
    }
}

/**
 * Value corresponding to a contract our source unit definition. For example in this code:
 * ```
 *   contract Foo {
 *      uint x;
 *      funciton main() {
 *          ... Foo.x ...
 *      }
 *   }
 * ```
 * 
 * The `Foo` identifier in the `Foo.x` member access evaluates to a `DefValue`.
 */
export class DefValue extends BaseInterpValue {
    constructor(
        public readonly def: sol.ContractDefinition | sol.SourceUnit
    ) {
        super();
    }

    pp(): string {
        const name = this.def instanceof sol.ContractDefinition ? this.def.name : this.def.sourceEntryKey;
        return `<${this.def.constructor.name} ${name}>`
    }
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

export type Value = PrimitiveValue | BuiltinFunction | BuiltinStruct | DefValue | Value[];

// @todo migrate to sol-dbg
type NonPoisonPrimitiveValue =
    | bigint // int/uint/enum
    | boolean // bool
    | Uint8Array // byte, bytesN
    | Address // address
    | FunctionValue // function types
    | Slice // array slices
    | View<any, BaseValue, any, sol.TypeNode>; // Pointer Values
export type NonPoisonValue = NonPoisonPrimitiveValue | BuiltinFunction | BuiltinStruct | DefValue | Value[];

export type LValue =
    | View<StateArea, BaseValue, any, sol.TypeNode>
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

type AddressConstructor = new (...v: any[]) => Address;
type ExternalFunRefConstructor = new (...v: any[]) => ExternalFunRef;
type InternalFunRefConstructor = new (...v: any[]) => InternalFunRef;
type SliceConstructor = new (...v: any[]) => Slice;
type ViewConstructor = new (...v: any[]) => View;
type PoisonConstructor = new (...v: any[]) => Poison;
type BuiltinFunctionConstructor = new (...v: any[]) => BuiltinFunction;
type BuiltinStructConstructor = new (...v: any[]) => BuiltinStruct;

export type ValueTypeConstructors =
    | BigIntConstructor
    | BooleanConstructor
    | Uint8ArrayConstructor
    | AddressConstructor
    | ExternalFunRefConstructor
    | InternalFunRefConstructor
    | SliceConstructor
    | ViewConstructor
    | PoisonConstructor
    | BuiltinFunctionConstructor
    | BuiltinStructConstructor
    | ArrayConstructor;

export type TypeConstructorToValueType<V extends ValueTypeConstructors> =
    V extends BigIntConstructor
    ? bigint
    : V extends BooleanConstructor
    ? boolean
    : V extends Uint8ArrayConstructor
    ? Uint8Array
    : V extends AddressConstructor
    ? Address
    : V extends ExternalFunRefConstructor
    ? ExternalFunRef
    : V extends InternalFunRefConstructor
    ? InternalFunRef
    : V extends SliceConstructor
    ? Slice
    : V extends ViewConstructor
    ? View
    : V extends PoisonConstructor
    ? Poison
    : V extends BuiltinFunctionConstructor
    ? BuiltinFunction
    : V extends BuiltinStructConstructor
    ? BuiltinStruct
    : V extends ArrayConstructor
    ? Value[]
    : never;

export function match<T extends ValueTypeConstructors>(
    v: Value,
    typeConstructor: T
): v is TypeConstructorToValueType<T> {
    if (typeConstructor === BigInt) {
        return typeof v === "bigint";
    }

    if (typeConstructor === Boolean) {
        return typeof v === "boolean";
    }

    if (typeConstructor === Uint8Array) {
        return v instanceof Uint8Array;
    }

    if (typeConstructor === Address) {
        return v instanceof Address;
    }

    if (typeConstructor === ExternalFunRef) {
        return v instanceof ExternalFunRef;
    }

    if (typeConstructor === InternalFunRef) {
        return v instanceof InternalFunRef;
    }

    if (typeConstructor === Slice) {
        return v instanceof Slice;
    }

    if (typeConstructor === View) {
        return v instanceof View;
    }

    if (typeConstructor === Poison) {
        return v instanceof Poison;
    }

    if (typeConstructor === BuiltinFunction) {
        return v instanceof BuiltinFunction;
    }

    if (typeConstructor === BuiltinStruct) {
        return v instanceof BuiltinStruct;
    }

    if (typeConstructor === Array) {
        return v instanceof Array;
    }

    nyi(`Type constructor ${typeConstructor}`);
}
