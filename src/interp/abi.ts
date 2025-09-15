import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Value } from "./value";
import * as ethABI from "web3-eth-abi";
import {
    nyi,
    View,
    Value as BaseValue,
    Struct,
    PointerMemView,
    bigIntToNum
} from "sol-dbg";
import { ppValue } from "./pp";
import { State } from "./state";
import { Address, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { decodeView, isValueType } from "./utils";
import { BaseInterpType } from "./types";

/**
 * Convert an interpreter type to an ABI type. This is analogous to `InferType.toABIEncodedType`,
 * however it handles runtime types only.
 */
function toABIEncodedType(type: BaseInterpType): BaseInterpType {
    if (type instanceof rtt.ArrayType) {
        if (type.size !== undefined) {
            return new rtt.TupleType(
                sol.repeat(toABIEncodedType(type.elementT), bigIntToNum(type.size))
            );
        }

        return new rtt.ArrayType(toABIEncodedType(type.elementT));
    }

    if (type instanceof rtt.StructType) {
        return new rtt.TupleType(type.fields.map(([, type]) => type));
    }

    if (type instanceof rtt.PointerType) {
        return new rtt.PointerType(toABIEncodedType(type.toType), type.location);
    }

    return type;
}

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
        return v.map((x) => valueToAbiValue(x, s, isLib));
    }

    if (v instanceof View) {
        // Storage pointers are passed by address to libraries
        if (isLib && v instanceof rtt.BaseStorageView) {
            sol.assert(v.endOffsetInWord === 32, `Unexpected non-aligned view {0}`, v);
            return v.key;
        }

        sol.assert(!(v instanceof rtt.BaseStorageView), "");
        return valueToAbiValue(decodeView(v, s), s, isLib);
    }

    if (v instanceof Struct) {
        return valueToAbiValue(
            v.entries.map(([, entry]) => entry),
            s,
            isLib
        );
    }

    if (v instanceof Map) {
        sol.assert(false, `Shouldn't encounter maps`);
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
        // For storage types we pass in the raw storage location
        if (isLib && t.location === sol.DataLocation.Storage) {
            return `uint32`;
        }

        sol.assert(!(t.location === sol.DataLocation.Storage), ``);
        return abiTypeToCanonicalName(t.toType, isLib);
    }

    if (t instanceof FunctionType) {
        return "function";
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
    // Pre-process int literals to uint256 and string literals to string memory
    // @todo dimo investigate why again we had a distinction between library and normal contract abi names?
    const typeNames = ts
        .map((t) => toABIEncodedType(t))
        .map(isLibrary ? sol.abiTypeToLibraryCanonicalName : sol.abiTypeToCanonicalName);
    const abiVals = vs.map((v) => valueToAbiValue(v, state, isLibrary));
    console.error(`encode abiVals: `, abiVals);
    return hexToBytes(ethABI.encodeParameters(typeNames, abiVals) as `0x${string}`);
}

/**
 * Convert an abi value obtained from web3-eth-abi to a sol-dbg BaseValue.
 * I.e. this may produce complex values such as `Struct`s and arrays.
 *
 * Note this expects the `type` to be specialized.
 */
export function abiValueToBaseValue(v: any, type: sol.TypeNode): BaseValue {
    if (type instanceof sol.IntType) {
        return BigInt(v);
    }

    if (type instanceof sol.BoolType) {
        return Boolean(v);
    }

    if (
        type instanceof sol.FixedBytesType ||
        (type instanceof sol.PointerType && type.to instanceof sol.BytesType)
    ) {
        return hexToBytes(v);
    }

    if (type instanceof sol.PointerType && type.to instanceof sol.StringType) {
        return v;
    }

    if (type instanceof sol.PointerType && type.to instanceof sol.ArrayType) {
        const elT = type.to.elementT;
        const res: BaseValue[] = [];

        for (let i = 0; i < v.__length__; i++) {
            res.push(abiValueToBaseValue(v[i], elT));
        }

        return res;
    }

    if (type instanceof sol.TupleType) {
        const fieldTs: sol.TypeNode[] = type.elements as sol.TypeNode[];
        const res: BaseValue[] = [];

        sol.assert(
            type.elements.length === v.__length__,
            `Mismatch in decoded tuple length. Expected {0} got {1}.`,
            type.elements.length,
            v.__length__
        );

        for (let i = 0; i < type.elements.length; i++) {
            res.push(abiValueToBaseValue(v[i], type.elements[i] as sol.TypeNode));
        }

        return res;
        return (v as any[]).map((el, i) => abiValueToBaseValue(el, fieldTs[i]));
    }

    if (type instanceof ExpStructType) {
        const fieldTs: sol.TypeNode[] = type.fields.map(([, type]) => type);
        const fieldVals = (v as any[]).map((el, i) => abiValueToBaseValue(el, fieldTs[i]));

        return new Struct(type.fields.map(([name], i) => [name, fieldVals[i]]));
    }

    if (type instanceof sol.AddressType) {
        return createAddressFromString(v);
    }

    nyi(`abiValueToBaseValue(${v}, ${type.pp()})`);
}

/**
 * Decode a the given bytes in `data`, given *generalized* type names `ts`.
 * This decodes the values, and encodes any complex values as neccessary in the passed-in `state`.
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
    ts: sol.TypeNode[],
    state: State,
    isLibrary: boolean = false
): Value[] {
    // Pre-process int literals to uint256
    const typeNames = ts
        .map((t) => toABIEncodedType(t))
        .map(isLibrary ? sol.abiTypeToLibraryCanonicalName : sol.abiTypeToCanonicalName);

    const decodeRes = ethABI.decodeParameters(typeNames, bytesToHex(data));
    console.error(`typenames: `, typeNames, `data:`, bytesToHex(data), `Decoded res: `, decodeRes);

    const res: Value[] = [];
    for (let i = 0; i < decodeRes.__length__; i++) {
        const generalType = ts[i];
        const memType = sol.specializeType(generalType, sol.DataLocation.Memory);
        const baseValue: BaseValue = abiValueToBaseValue(decodeRes[i], memType);
        let val: Value;

        if (isValueType(memType)) {
            // Primitive value - just return it
            val = baseValue as Value;
        } else {
            // Non-primitive value - encode it in memory
            sol.assert(memType instanceof sol.PointerType, ``);
            const view = PointerMemView.allocMemFor(baseValue, memType.to, state.memAllocator);
            view.encode(baseValue, state.memory, state.memAllocator);
            val = view;
        }

        res.push(val);
    }

    console.error(`Decoded: ${res.map(ppValue).join(", ")}`);

    return res;
}
