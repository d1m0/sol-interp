import * as sol from "solc-typed-ast";
import { Value } from "./value";
import {
    ArrayType,
    BytesType,
    EventDesc,
    isArrayLikeView,
    PointerType,
    PrimitiveValue,
    StringType,
    StructType,
    View
} from "sol-dbg";
import { BaseInterpType, typeIdToRuntimeType } from "./types";
import { decodeView, isStructView, isValueType, padToMulipleOf32 } from "./utils";
import { encode } from "./abi";
import { State } from "./state";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { isFailure } from "sol-dbg/dist/debug/decoding/utils";
import { concatBytes } from "@ethereumjs/util";

/**
 * Encode a reference-type event argument `v` into bytes suitable for hashing it to a topic.
 * Follows: https://docs.soliditylang.org/en/latest/abi-spec.html#encoding-of-indexed-event-parameters
 */
export function encodeEventArgToTopic(v: Value, type: BaseInterpType, state: State): Uint8Array {
    if (type instanceof PointerType) {
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
            sol.assert(!isFailure(len), ``);

            const elEncs: Uint8Array[] = [];
            const isElPrimitive = isValueType(toT.elementT);

            for (let i = 0n; i < len; i++) {
                const elView = v.indexView(i, state);
                sol.assert(!isFailure(elView), ``);

                const elVal = isElPrimitive
                    ? (decodeView(elView, state) as PrimitiveValue)
                    : elView;
                // pad to multiple of 32
                elEncs.push(padToMulipleOf32(encodeEventArgToTopic(elVal, toT.elementT, state)));
            }

            return concatBytes(...elEncs);
        }

        if (toT instanceof StructType) {
            const fieldEncs: Uint8Array[] = [];
            sol.assert(isStructView(v), ``);

            for (const [field, fieldT] of toT.fields) {
                const fieldView = v.fieldView(field);
                sol.assert(!isFailure(fieldView), ``);

                const elVal = isValueType(fieldT)
                    ? (decodeView(fieldView, state) as PrimitiveValue)
                    : fieldView;
                // pad to multiple of 32
                fieldEncs.push(padToMulipleOf32(encodeEventArgToTopic(elVal, fieldT, state)));
            }

            return concatBytes(...fieldEncs);
        }
    }

    // Value type
    return encode([v], [type], state);
}

export function buildEvent(event: sol.EventDefinition, args: Value[], state: State): EventDesc {
    const topics: Uint8Array[] = [];

    // For non-anonymous events the first topic is the signature hash
    if (!event.anonymous) {
        topics.push(sol.signatureHash(event));
    }

    sol.assert(args.length === event.vParameters.vParameters.length, ``);
    const payloadValues: Value[] = [];
    const payloadTypes: BaseInterpType[] = [];

    // The rest of the topics are
    for (let i = 0; i < args.length; i++) {
        const param = event.vParameters.vParameters[i];
        const paramT = typeIdToRuntimeType(
            sol.typeOf(param),
            event.requiredContext,
            sol.DataLocation.CallData
        );

        if (!param.indexed) {
            payloadValues.push(args[i]);
            payloadTypes.push(paramT);
            continue;
        }

        const encodedArg = encodeEventArgToTopic(args[i], paramT, state);
        const topic = isValueType(paramT) ? encodedArg : keccak256(encodedArg);
        topics.push(topic);
    }

    // Build Payload
    const payload = encode(payloadValues, payloadTypes, state);

    return {
        payload,
        topics
    };
}
