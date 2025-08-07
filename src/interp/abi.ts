import * as sol from "solc-typed-ast";
import { Value } from "./value";
import * as ethABI from "web3-eth-abi";
import { nyi, View, Value as BaseValue, Struct } from "sol-dbg";
import { ppValue } from "./pp";
import { State } from "./state";
import { Address, hexToBytes } from "@ethereumjs/util";
import { decodeView } from "./utils";

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
        return valueToAbiValue([v.entries.map(([, entry]) => entry)], s);
    }

    if (v instanceof Map) {
        sol.assert(false, `Cannot ecnode maps`);
    }

    nyi(`valueToAbiValue${ppValue(v)}`);
}

export function encode(
    vs: Value[],
    ts: sol.TypeNode[],
    state: State,
    infer: sol.InferType,
    isLibrary: boolean = false,
    encVersion = sol.ABIEncoderVersion.V2
): Uint8Array {
    // @todo dimo investigate why again we had a distinction between library and normal contract abi names?
    const typeNames = ts
        .map((t) => infer.toABIEncodedType(t, encVersion))
        .map(isLibrary ? sol.abiTypeToLibraryCanonicalName : sol.abiTypeToCanonicalName);
    const abiVals = vs.map((v) => valueToAbiValue(v, state));
    return hexToBytes(ethABI.encodeParameters(typeNames, abiVals) as `0x${string}`);
}

export function abiValueToBaseValue(v: any, abiType: sol.TypeNode): BaseValue {
    if (abiType instanceof sol.IntType) {
        return BigInt(v);
    }

    if (abiType instanceof sol.BoolType) {
        return Boolean(v);
    }

    if (
        abiType instanceof sol.FixedBytesType ||
        (abiType instanceof sol.PointerType && abiType.to instanceof sol.BytesType)
    ) {
        return hexToBytes(v);
    }

    if (abiType instanceof sol.PointerType && abiType.to instanceof sol.StringType) {
        return v;
    }

    if (abiType instanceof sol.PointerType && abiType.to instanceof sol.ArrayType) {
        const elT = abiType.to.elementT;
        return (v as any[]).map((el) => abiValueToBaseValue(el, elT));
    }

    if (abiType instanceof sol.TupleType) {
        const fieldTs: sol.TypeNode[] = abiType.elements as sol.TypeNode[];

        return (v as any[]).map((el, i) => abiValueToBaseValue(el, fieldTs[i]));
    }

    nyi(`abiValueToBaseValue(${v}, ${abiType.pp()})`);
}
