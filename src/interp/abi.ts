import { assert, repeat, DataLocation } from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Value } from "./value";
import * as ethABI from "web3-eth-abi";
import { nyi, View, Value as BaseValue, Struct, PointerMemView, bigIntToNum } from "sol-dbg";
import { ppValue } from "./pp";
import { State } from "./state";
import { Address, concatBytes, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { bytes24, decodeView, isValueType } from "./utils";
import { BaseInterpType } from "./types";

/**
 * Helper to decide if we should skip a struct field when assing memory structs due to it containing a map
 */
export function skipFieldDueToMap(t: rtt.BaseRuntimeType): boolean {
    if (t instanceof rtt.MappingType) {
        return true;
    }

    if (t instanceof rtt.PointerType) {
        return skipFieldDueToMap(t.toType);
    }

    if (t instanceof rtt.ArrayType) {
        return skipFieldDueToMap(t.elementT);
    }

    return false;
}

/**
 * Convert an interpreter type to an ABI type. This is analogous to `InferType.toABIEncodedType`,
 * however it handles runtime types only.
 */
export function toABIEncodedType(type: BaseInterpType): BaseInterpType {
    if (type instanceof rtt.ArrayType) {
        if (type.size !== undefined) {
            return new rtt.TupleType(
                repeat(toABIEncodedType(type.elementT), bigIntToNum(type.size))
            );
        }

        return new rtt.ArrayType(toABIEncodedType(type.elementT));
    }

    if (type instanceof rtt.StructType) {
        return new rtt.TupleType(type.fields.map(([, type]) => type));
    }

    if (type instanceof rtt.PointerType) {
        // For storage types we pass in the raw storage location
        if (type.location === DataLocation.Storage) {
            return rtt.uint256;
        }

        const innerT = toABIEncodedType(type.toType);

        return innerT instanceof rtt.TupleType
            ? innerT
            : new rtt.PointerType(innerT, type.location);
    }

    if (type instanceof rtt.FunctionType) {
        return bytes24;
    }

    return type;
}

const _NONE_ = new Object();

/**
 * Convert a sol-dbg `Value` (so potentially involving structs) to an abi-like value
 * acceptable to `web3-eth-abi`.
 *
 * Note that storage pointers and libraries are a special case - they are passed directly as
 * addresses since libraries are called with DELEGATECALL.
 */
function valueToAbiValue(v: Value | BaseValue, s: State, isLib: boolean): any {
    if (
        typeof v === "bigint" ||
        typeof v === "boolean" ||
        v instanceof Uint8Array ||
        typeof v === "string"
    ) {
        return v;
    }

    if (v instanceof Address) {
        return v.toString();
    }

    if (v instanceof Array) {
        return v.map((x) => valueToAbiValue(x, s, isLib)).filter((v) => v !== _NONE_);
    }

    if (v instanceof View) {
        // Storage pointers are passed by address to libraries
        if (isLib && v instanceof rtt.BaseStorageView) {
            assert(v.endOffsetInWord === 32, `Unexpected non-aligned view {0}`, v);
            return v.key;
        }

        assert(!(v instanceof rtt.BaseStorageView), "");
        return valueToAbiValue(decodeView(v, s), s, isLib);
    }

    if (v instanceof Struct) {
        return v.entries
            .map(([, entry]) => valueToAbiValue(entry, s, isLib))
            .filter((v) => v !== _NONE_);
    }

    if (v instanceof Map) {
        return _NONE_;
    }

    // External fun refs are stored as bytes24 - address then selector
    if (v instanceof rtt.ExternalFunRef) {
        return concatBytes(v.address.toBytes(), v.selector);
    }

    nyi(`valueToAbiValue${ppValue(v)}`);
}

/**
 * Get the canonical name for the `TypeNode` `t`, to be used for encoding the
 * type.
 */
export function abiTypeToCanonicalName(t: rtt.BaseRuntimeType, isLib: boolean): string {
    if (
        t instanceof rtt.IntType ||
        t instanceof rtt.FixedBytesType ||
        t instanceof rtt.BoolType ||
        t instanceof rtt.BytesType ||
        t instanceof rtt.StringType ||
        t instanceof rtt.AddressType
    ) {
        return t.pp();
    }

    if (t instanceof rtt.ArrayType) {
        return `${abiTypeToCanonicalName(t.elementT, isLib)}[${t.size ? t.size.toString(10) : ""}]`;
    }

    if (t instanceof rtt.TupleType) {
        return `(${t.elementTypes
            .map((elementT) => abiTypeToCanonicalName(elementT, isLib))
            .join(",")})`;
    }

    // Locations are skipped in signature canonical names
    if (t instanceof rtt.PointerType) {
        assert(!(t.location === DataLocation.Storage), ``);
        return abiTypeToCanonicalName(t.toType, isLib);
    }

    assert(false, "Unexpected ABI Type: {0}", t);
}

/**
 * Encode the given interpeter values `vs` with types `ts` in the state `state` and return the resulting bytes.
 * Note that the given type names are assumed to be *generalized*.
 */
export function encode(
    vs: Value[],
    ts: BaseInterpType[],
    state: State,
    isLibrary: boolean = false
): Uint8Array {
    const abiTypes = ts.map((t) => toABIEncodedType(t)).filter((t) => !skipFieldDueToMap(t));
    const typeNames = abiTypes.map((t) => abiTypeToCanonicalName(t, isLibrary));

    const abiVals = vs.map((v) => valueToAbiValue(v, state, isLibrary));

    return hexToBytes(ethABI.encodeParameters(typeNames, abiVals) as `0x${string}`);
}

/**
 * Convert an abi value obtained from web3-eth-abi to a BaseValue.
 * I.e. this may produce complex values such as `Struct`s and arrays.
 */
export function abiValueToBaseValue(v: any, type: rtt.BaseRuntimeType): BaseValue {
    if (type instanceof rtt.IntType) {
        return BigInt(v);
    }

    if (type instanceof rtt.BoolType) {
        return Boolean(v);
    }

    if (
        type instanceof rtt.FixedBytesType ||
        (type instanceof rtt.PointerType && type.toType instanceof rtt.BytesType)
    ) {
        return hexToBytes(v);
    }

    if (type instanceof rtt.AddressType) {
        return createAddressFromString(v);
    }

    if (type instanceof rtt.PointerType && type.toType instanceof rtt.StringType) {
        return v;
    }

    if (type instanceof rtt.PointerType && type.toType instanceof rtt.ArrayType) {
        const elT = type.toType.elementT;
        const res: BaseValue[] = [];

        const len = v.length !== undefined ? v.length : v.__length__;

        for (let i = 0; i < len; i++) {
            res.push(abiValueToBaseValue(v[i], elT));
        }

        return res;
    }

    if (type instanceof rtt.TupleType) {
        const res: BaseValue[] = [];

        assert(
            type.elementTypes.length === v.__length__,
            `Mismatch in decoded tuple length. Expected {0} got {1}.`,
            type.elementTypes.length,
            v.__length__
        );

        for (let i = 0; i < type.elementTypes.length; i++) {
            res.push(abiValueToBaseValue(v[i], type.elementTypes[i]));
        }

        return res;
    }

    nyi(`abiValueToBaseValue(${v}, ${type.pp()})`);
}

function liftABIBaseValue(v: BaseValue, type: rtt.BaseRuntimeType): BaseValue {
    if (type instanceof rtt.PointerType) {
        return liftABIBaseValue(v, type.toType);
    }

    if (type instanceof rtt.ArrayType) {
        assert(v instanceof Array, ``);
        return v.map((el) => liftABIBaseValue(el, type.elementT));
    }

    if (type instanceof rtt.TupleType) {
        assert(v instanceof Array, ``);
        return v.map((el, i) => liftABIBaseValue(el, type.elementTypes[i]));
    }

    if (type instanceof rtt.StructType) {
        assert(v instanceof Array && v.length === type.fields.length, ``);
        const fields: Array<[string, BaseValue]> = [];

        for (let i = 0; i < v.length; i++) {
            const [name, fieldT] = type.fields[i];
            fields.push([name, liftABIBaseValue(v[i], fieldT)]);
        }

        return new Struct(fields);
    }

    return v;
}

/**
 * Decode the given bytes in `data`, given target types `ts` and a given state.
 * This decodes the values, and encodes any complex values as neccessary in the passed-in `state`.
 *
 * In general:
 *  - value types get decoded and returned directly
 *  - storage pointers can only be passed to libraries as (uint256). For those we construct a view with the given location
 *  - calldata pointers are returned as simple views on the data
 *  - for memory pointers we allocate memory and encode the decoded value into it and return  a view onto the new memory
 *
 * @param data
 * @param ts
 * @param state
 * @param infer
 * @param isLibrary
 * @param encVersion
 * @returns
 */
export function decode(data: Uint8Array, ts: BaseInterpType[], state: State): Value[] {
    const abiTypes = ts.map((t) => toABIEncodedType(t));
    const views = rtt.makeCalldataViews(abiTypes, 0n);

    const res: Value[] = [];
    for (let i = 0; i < views.length; i++) {
        const typ = ts[i];
        const abiType = abiTypes[i];
        const view = views[i];

        const baseValue: BaseValue = liftABIBaseValue(view.decode(data), typ);
        let val: Value;

        if (isValueType(typ)) {
            // Primitive value - just return it
            val = baseValue as Value;
        } else if (typ instanceof rtt.PointerType && typ.location === DataLocation.Storage) {
            assert(
                abiType instanceof rtt.IntType && typeof baseValue === "bigint",
                `Unexpected pointer storage type ${abiType.pp()} or val ${baseValue}`
            );
            val = rtt.makeStorageView(typ, [baseValue, 32]);
        } else if (typ instanceof rtt.PointerType && typ.location === DataLocation.Memory) {
            // Non-primitive value - encode it in memory
            const memView = PointerMemView.allocMemFor(baseValue, typ.toType, state.memAllocator);
            memView.encode(baseValue, state.memory, state.memAllocator);
            val = memView;
        } else if (typ instanceof rtt.PointerType && typ.location === DataLocation.CallData) {
            val = view;
        } else if (typ instanceof rtt.FunctionType) {
            assert(
                baseValue instanceof Uint8Array,
                `Unexpected base value for function ref ${baseValue}`
            );
            val = new rtt.ExternalFunRef(new Address(baseValue.slice(0, 20)), baseValue.slice(20));
        } else {
            nyi(`decode type ${typ.pp()}`);
        }

        res.push(val);
    }

    return res;
}
