import * as sol from "solc-typed-ast";
import { Value } from "./value";
import { ArrayType, BytesType, EventDesc, isArrayLikeView, nyi, PointerType, PrimitiveValue, StringType, View } from "sol-dbg";
import { BaseInterpType, typeIdToRuntimeType } from "./types";
import { decodeView, isValueType } from "./utils";
import { encode } from "./abi";
import { State } from "./state";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { isFailure } from "sol-dbg/dist/debug/decoding/utils";
import { concatBytes, setLengthLeft } from "@ethereumjs/util";

export function encodeComplexEventArg(v: Value, type: BaseInterpType, state: State): Uint8Array {
    sol.assert(type instanceof PointerType, ``);
    const toT = type.toType;

    if (toT instanceof StringType || toT instanceof BytesType) {
        sol.assert(v instanceof View, ``);
        const val = decodeView(v, state);
        sol.assert(val instanceof Uint8Array, ``);
        return val;
    }

    if (toT instanceof ArrayType) {
        sol.assert(isArrayLikeView(v), ``);
        const len = v.size(state);
        sol.assert(!isFailure(len), ``)

        const elEncs: Uint8Array[] = [];
        const isElPrimitive = isValueType(toT.elementT);

        for (let i = 0n; i < len; i++) {
            let elView = v.indexView(i, state);
            sol.assert(!isFailure(elView), ``);

            let elVal = isElPrimitive ? decodeView(elView, state) as PrimitiveValue : elView;
            const elEnc = encodeComplexEventArg(elVal, toT.elementT, state);
            // pad to multiple of 32
        }

        return concatBytes(...elEncs);
    }

    // todo structs
    nyi(`Event argument encodign of type ${toT.pp()}`);
}

export function eventArgToTopic(v: Value, type: BaseInterpType, state: State): Uint8Array {
    if (isValueType(type)) {
        const topic = encode([v], [type], state)
        sol.assert(topic.length === 32, ``);
        return topic;
    }

    const encoding = encodeComplexEventArg(v, type, state);
    return keccak256(encoding);
}

export function buildEvent(event: sol.EventDefinition, args: Value[], state: State): EventDesc {
    const topics: Uint8Array[] = [];
    let payload: Uint8Array;

    // For non-anonymous events the first topic is the signature hash
    if (!event.anonymous) {
        topics.push(sol.signatureHash(event));
    }

    sol.assert(args.length === event.vParameters.vParameters.length, ``)

    // The rest of the topics are 
    for (let i = 0; i < args.length; i++) {
        const param = event.vParameters.vParameters[i];

        if (!param.indexed) {
            continue;
        }

        const paramT = typeIdToRuntimeType(sol.typeOf(param), event.requiredContext, sol.DataLocation.CallData)
        const topic = eventArgToTopic(args[i], paramT, state);
        topics.push(topic)
    }

    // todo payload

    return {
        payload,
        topics,
    }
}