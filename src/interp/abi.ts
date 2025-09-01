import * as sol from "solc-typed-ast";
import { Value } from "./value";
import * as ethABI from "web3-eth-abi";
import {
    nyi,
    View,
    Value as BaseValue,
    Struct,
    uint256,
    ExpStructType,
    PointerMemView,
    bigIntToNum
} from "sol-dbg";
import { ppValue } from "./pp";
import { State } from "./state";
import { Address, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { decodeView, int256, isValueType } from "./utils";

/**
 * Convert an interpreter type to an ABI type. This is analogous to `InferType.toABIEncodedType`,
 * however it handles `ExpStructType` and doesnt deal with user-defined types.
 *
 * This assumes the type is "generalized" - i.e. it doesn't contain any `PointerType`s.
 */
function toABIEncodedType(type: sol.TypeNode): sol.TypeNode {
    if (type instanceof sol.StringLiteralType) {
        return sol.types.stringMemory.to;
    }

    if (type instanceof sol.ArrayType) {
        if (type.size !== undefined) {
            return new sol.TupleType(
                sol.repeat(toABIEncodedType(type.elementT), bigIntToNum(type.size))
            );
        }

        return new sol.ArrayType(toABIEncodedType(type.elementT));
    }

    if (type instanceof ExpStructType) {
        return new sol.TupleType(type.fields.map(([, type]) => type));
    }

    return type;
}

/**
 * Convert a sol-dbg `Value` (so potentially involving structs) to an abi-like value
 * acceptable to `web3-eth-abi`.
 */
function valueToAbiValue(v: Value | BaseValue, s: State): any {
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
        return v.map((x) => valueToAbiValue(x, s));
    }

    if (v instanceof View) {
        return valueToAbiValue(decodeView(v, s), s);
    }

    if (v instanceof Struct) {
        return valueToAbiValue(
            v.entries.map(([, entry]) => entry),
            s
        );
    }

    if (v instanceof Map) {
        sol.assert(false, `Cannot ecnode maps`);
    }

    nyi(`valueToAbiValue${ppValue(v)}`);
}

/**
 * Encode the given interpeter values `vs` with types `ts` in the state `state` and return the resulting bytes.
 * Note that the given type names are assumed to be *generalized*.
 */
export function encode(
    vs: Value[],
    ts: sol.TypeNode[],
    state: State,
    isLibrary: boolean = false
): Uint8Array {
    // Pre-process int literals to uint256 and string literals to string memory
    // @todo dimo investigate why again we had a distinction between library and normal contract abi names?
    const typeNames = ts
        .map((t, i) =>
            t instanceof sol.IntLiteralType ? ((vs[i] as bigint) < 0n ? int256 : uint256) : t
        )
        .map((t) => toABIEncodedType(t))
        .map(isLibrary ? sol.abiTypeToLibraryCanonicalName : sol.abiTypeToCanonicalName);
    const abiVals = vs.map((v) => valueToAbiValue(v, state));
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
