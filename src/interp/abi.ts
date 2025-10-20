import { assert, repeat, DataLocation, } from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Value } from "./value";
import * as ethABI from "web3-eth-abi";
import { nyi, View, Value as BaseValue, Struct, PointerMemView, bigIntToNum } from "sol-dbg";
import { ppValue } from "./pp";
import { State } from "./state";
import {
    Address,
    concatBytes,
    createAddressFromString,
    equalsBytes,
    hexToBytes
} from "@ethereumjs/util";
import { bytes24, decodeView, deref, indexView, isStructView, isValueType, length } from "./utils";
import { BaseInterpType } from "./types";
import { isArrayLikeView } from "./view";

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

/**
 * Convert an interpreter `Value` to an abi value acceptable to `web3-eth-abi`.
 *
 * Note that storage pointers and libraries are a special case - they are passed directly as
 * addresses since libraries are called with DELEGATECALL.
 * @todo re-write valueToAbiValue - seems confusing
 * @todo write rules about the correspondance between Run-time Types and Values
 */
function valueToAbiValue(v: Value, typ: BaseInterpType, s: State): any {
    // Storage pointers are encoded as ints in library calls
    if (typ instanceof rtt.IntType && (v instanceof rtt.ArrayStorageView || v instanceof rtt.StructStorageView || v instanceof rtt.PackedArrayStorageView)) {
        assert(v.endOffsetInWord === 32, `Unexpected non-aligned view {0}`, v);
        return v.key;
    }

    // Primitive values
    if (isValueType(typ) && v instanceof View) {
        v = decodeView(v, s) as Value;
    }

    if (rtt.isPointerView(v)) {
        v = deref(v, s);
    }

    if (typ instanceof rtt.IntType) {
        assert(typeof v === "bigint", `Expected bigint for ${typ.pp()} not ${ppValue(v)}`)
        return v;
    }

    if (typ instanceof rtt.BoolType) {
        assert(typeof v === "boolean", `Expected bool for ${typ.pp()} not ${ppValue(v)}`)
        return v;
    }

    if (typ instanceof rtt.AddressType) {
        assert(v instanceof Address, `Expected Address for ${typ.pp()} not ${ppValue(v)}`)
        return v.toString();
    }

    // External fun refs are stored as bytes24 - address then selector
    if (typ instanceof rtt.FunctionType) {
        assert(v instanceof rtt.ExternalFunRef, `Expected ExternalFunRef for ${typ.pp()} not ${ppValue(v)}`)
        return concatBytes(v.address.toBytes(), v.selector);
    }

    if (typ instanceof rtt.FixedBytesType) {
        assert(v instanceof Uint8Array, `Expected Uint8Array for ${typ.pp()} not ${ppValue(v)}`)
        return v;
    }

    // Pointer ref values (views)
    if (typ instanceof rtt.PointerType) {
        return valueToAbiValue(v, typ.toType, s);
    }

    if (typ instanceof rtt.BytesType) {
        assert(v instanceof View && v.type instanceof rtt.BytesType, `Expected bytes View for ${typ.pp()} not ${ppValue(v)}`)
        return decodeView(v, s)
    }

    if (typ instanceof rtt.StringType) {
        assert(v instanceof View && v.type instanceof rtt.StringType, `Expected string View for ${typ.pp()} not ${ppValue(v)}`)
        return decodeView(v, s)
    }

    if (typ instanceof rtt.ArrayType) {
        assert(isArrayLikeView(v), `Expected Array for ${typ.pp()} not ${ppValue(v)}`)
        const len = length(v, s);
        assert(typeof len === "bigint", `Failed decoding len`)

        const res: any[] = [];
        const elT = typ.elementT;

        for (let i = 0n; i < len; i++) {
            res.push(valueToAbiValue(indexView(v, i, s), elT, s))
        }

        return res;
    }

    if (typ instanceof rtt.TupleType) {
        const res: any[] = [];

        // Fixed arrays encoded as tuples
        if (isArrayLikeView(v)) {
            for (let i = 0; i < typ.elementTypes.length; i++) {
                res.push(valueToAbiValue(indexView(v, BigInt(i), s), typ.elementTypes[i], s))
            }

            return res;
        }

        // Structs
        if (isStructView(v)) {
            const structT = (v as unknown as View).type as rtt.StructType;

            for (let i = 0; i < typ.elementTypes.length; i++) {
                const [name, fieldT] = structT.fields[i];

                if (skipFieldDueToMap(fieldT)) {
                    continue;
                }

                const fieldV = v.fieldView(name);
                assert(!(fieldV instanceof rtt.DecodingFailure), ``);

                res.push(valueToAbiValue(fieldV, typ.elementTypes[i], s))
            }

            return res;
        }
    }

    /*
    if (typ instanceof rtt.StructType) {
        assert(isStructView(v), `Expected Array for ${typ.pp()} not ${v}`)
        const res: any[] = [];

        for (const [name, fieldT] of typ.fields) {
            if (skipFieldDueToMap(fieldT)) {
                continue;
            }

            const fieldV = v.fieldView(name);
            assert(!(fieldV instanceof rtt.DecodingFailure), ``);

            res.push(valueToAbiValue(fieldV, fieldT, s))
        }

        return res;
    }
    */

    nyi(`valueToAbiValue(${ppValue(v)}, ${typ.pp()})`);
}

/**
 * Get the canonical name for the `TypeNode` `t`, to be used for encoding the
 * type.
 */
export function abiTypeToCanonicalName(t: rtt.BaseRuntimeType): string {
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
        return `${abiTypeToCanonicalName(t.elementT)}[${t.size ? t.size.toString(10) : ""}]`;
    }

    if (t instanceof rtt.TupleType) {
        return `(${t.elementTypes
            .map((elementT) => abiTypeToCanonicalName(elementT))
            .join(",")})`;
    }

    // Locations are skipped in signature canonical names
    if (t instanceof rtt.PointerType) {
        return abiTypeToCanonicalName(t.toType);
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
    const typeNames = abiTypes.map((t) => abiTypeToCanonicalName(t));

    const abiVals = vs.map((v, i) => valueToAbiValue(v, abiTypes[i], state));

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
export function decode(
    data: Uint8Array,
    ts: BaseInterpType[],
    state: State,
    base: bigint = 0n
): Value[] {
    const abiTypes = ts.map((t) => toABIEncodedType(t));
    const views = rtt.makeCalldataViews(abiTypes, base);

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

/**
 * IF the given data:
 *  - begins with the specified selector
 *  - decodes to the given types `ts` without failures
 *
 * Then return the decoded values. Otherwise return undefined.
 */
export function decodesWithSelector(
    selector: Uint8Array,
    data: Uint8Array,
    ts: BaseInterpType[],
    state: State
): Value[] | undefined {
    if (!equalsBytes(data.slice(0, 4), selector)) {
        return undefined;
    }

    const vals = decode(data, ts, state, 4n);
    for (const v of vals) {
        if (rtt.hasPoison(v)) {
            return undefined;
        }
    }

    return vals;
}
