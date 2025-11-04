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
import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { State } from "./state";
import { Address } from "@ethereumjs/util";
import { Interpreter } from "./interp";
import { concretize, substitute } from "./polymorphic";

export abstract class BaseInterpValue implements sol.PPAble {
    abstract pp(): string;
}

export class BuiltinFunction extends BaseInterpValue {
    constructor(
        public readonly name: string,
        public readonly type: rtt.FunctionType,
        protected readonly _call: (
            interp: Interpreter,
            state: State,
            self: BuiltinFunction
        ) => Value[],
        // Any curried arguments. E.g. `arr` in `arr.push(...)`
        public readonly curriedArgs: Value[] = [],
        // The types of any curried arguments. E.g. type of `arr` in `arr.push(...)`
        protected readonly curriedArgTs: rtt.BaseRuntimeType[] = [],
        // Flag specifying if this builtin expects an implicit first argument. E.g. `arr` in `arr.push(...)`
        public readonly implicitFirstArg = false,
        // Flag specifying if this builtin corresponds to a non-function field. E.g. `(address).balance`
        public readonly isField = false,
        // Flag specifying if this builtin performs an external call (i.e. *call, send, transfer)
        public readonly isExternalCall = false
    ) {
        super();
    }

    alias(newName: string): BuiltinFunction {
        return new BuiltinFunction(
            newName,
            this.type,
            this._call,
            this.curriedArgs,
            this.curriedArgTs,
            this.implicitFirstArg,
            this.isField
        );
    }

    pp(): string {
        return `<builtin fun ${this.type.pp()}>`;
    }

    concretize(argTs: rtt.BaseRuntimeType[]): BuiltinFunction {
        const [concreteFormalArgs, subst] = concretize(this.type.argTs, [
            ...this.curriedArgTs,
            ...argTs
        ]);
        const concreteFormalRets = this.type.retTs.map((retT) => substitute(retT, subst));

        const concreteT = new rtt.FunctionType(
            concreteFormalArgs,
            this.type.external,
            this.type.mutability,
            concreteFormalRets
        );

        return new BuiltinFunction(
            this.name,
            concreteT,
            this._call,
            this.curriedArgs,
            this.curriedArgTs,
            this.implicitFirstArg,
            this.isField
        );
    }

    curry(args: Value[], argTs: rtt.BaseRuntimeType[]): BuiltinFunction {
        return new BuiltinFunction(
            this.name,
            this.type,
            this._call,
            [...this.curriedArgs, ...args],
            [...this.curriedArgTs, ...argTs],
            this.implicitFirstArg,
            this.isField
        );
    }

    call(interp: Interpreter, state: State, concretizedBuiltin: BuiltinFunction): Value[] {
        return this._call(interp, state, concretizedBuiltin);
    }

    getArgs(numArgs: number, state: State): Value[] {
        const res: Value[] = [];

        sol.assert(state.scope !== undefined, ``);
        for (let i = 0; i < numArgs; i++) {
            const argV = state.scope.lookup(`arg_${i}`);
            sol.assert(argV !== undefined, ``);
            res.push(argV);
        }

        return res;
    }
}

export class BuiltinStruct extends BaseInterpValue {
    constructor(
        public readonly name: string,
        public readonly type: rtt.StructType,
        public readonly fields: Array<[string, Value]>
    ) {
        super();
    }

    pp(): string {
        return `<builtin struct ${this.name}>`;
    }

    getField(field: string): Value | undefined {
        const options = this.fields.filter(([name]) => name === field);

        if (options.length !== 1) {
            return undefined;
        }

        return options[0][1];
    }
}

/**
 * Value corresponding to a contract or source unit definition. For example in this code:
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
        public readonly def:
            | sol.ContractDefinition
            | sol.SourceUnit
            | sol.FunctionDefinition
            | sol.EventDefinition
            | sol.ErrorDefinition
            | sol.StructDefinition
            | sol.EnumDefinition
            | sol.UserDefinedValueTypeDefinition
    ) {
        super();
    }

    pp(): string {
        const name = this.def instanceof sol.SourceUnit ? this.def.sourceEntryKey : this.def.name;
        return `<${this.def.constructor.name} ${name}>`;
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

export abstract class BaseTypeValue extends BaseInterpValue {}

export class TypeValue extends BaseTypeValue {
    constructor(public readonly type: rtt.BaseRuntimeType) {
        super();
    }
    pp(): string {
        return `<typename ${this.type.pp()}>`;
    }
}

export class TypeTuple extends BaseTypeValue {
    constructor(public readonly elements: BaseTypeValue[]) {
        super();
    }
    pp(): string {
        return `<typename ${this.elements.map((e) => e.pp()).join(", ")}>`;
    }
}

export function typeValueToType(t: BaseTypeValue): rtt.BaseRuntimeType {
    if (t instanceof TypeValue) {
        return t.type;
    }

    if (t instanceof TypeTuple) {
        return new rtt.TupleType(t.elements.map(typeValueToType));
    }

    nyi(`typeValueToType(${t.constructor.name})`);
}

/**
 * Primtiive value used to denote the result of a `new T` expression.
 * (Note that this is different from `new T(...)`)
 */
export class NewCall {
    constructor(public readonly type: sol.TypeNode) {}
}

/**
 * Primtiive value used to annotate an external call target with additional call parameters such as gas, value and salt.
 */
export class ExternalCallDescription {
    constructor(
        /**
         * Target is on of:
         *  - Address for (address).*call
         *  - ContractDefinition for (new Contract)
         *  - ExternalFunRef for var.method()
         */
        public readonly target: Address | NewCall | ExternalFunRef,
        public value: bigint | undefined = undefined,
        public gas: bigint | undefined = undefined,
        public salt: Uint8Array | undefined = undefined,
        public callKind:
            | "call"
            | "staticcall"
            | "delegatecall"
            | "send"
            | "transfer"
            | "solidity_call"
            | "contract_deployment"
    ) {}
}

export const none = new NoneValue();

export type Value =
    | PrimitiveValue
    | BuiltinFunction
    | BuiltinStruct
    | DefValue
    | TypeValue
    | TypeTuple
    | ExternalCallDescription
    | NewCall
    | Value[];

// @todo migrate to sol-dbg
type NonPoisonPrimitiveValue =
    | bigint // int/uint/enum
    | boolean // bool
    | Uint8Array // byte, bytesN
    | Address // address
    | FunctionValue // function types
    | Slice // array slices
    | View<any, BaseValue, any, rtt.BaseRuntimeType> // Pointer Values
    | TypeValue // Type Values and TypeTuples are considred "primitive" since they can be passed in to builtin functions (e.g. abi.decode).
    | TypeTuple
    | NewCall
    | ExternalCallDescription;

export type NonPoisonValue =
    | NonPoisonPrimitiveValue
    | BuiltinFunction
    | BuiltinStruct
    | DefValue
    | Value[];

export class BytesStorageLength {
    constructor(public readonly view: rtt.BytesStorageView) {}
}

export type LValue =
    | View<StateArea, BaseValue, any, rtt.BaseRuntimeType>
    | null // empty components of tuple assignments
    | BytesStorageLength
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
        v instanceof Poison ||
        v instanceof BaseTypeValue ||
        v instanceof ExternalCallDescription ||
        v instanceof NewCall
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
