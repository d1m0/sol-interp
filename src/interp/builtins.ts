import { BuiltinFunctionType, types } from "solc-typed-ast";
import * as sol from "solc-typed-ast";
import { BuiltinFunction, BuiltinStruct, none, TypeTuple, typeValueToType, Value } from "./value";
import { State } from "./state";
import { Assert, EmptyArrayPop, InternalError } from "./exceptions";
import { Interpreter } from "./interp";
import { TOptional, TRest, TUnion, TVar } from "./polymorphic";
import {
    ArrayStorageView,
    BytesMemView,
    BytesStorageView,
    DecodingFailure,
    IntStorageView,
    PointerMemView,
    simplifyType,
    uint256,
    View
} from "sol-dbg";
import { bytes1, decodeView, getContract, makeZeroValue } from "./utils";
import { concatBytes } from "@ethereumjs/util";
import { decode, encode } from "./abi";

function getArgs(numArgs: number, state: State): Value[] {
    const res: Value[] = [];
    sol.assert(state.scope !== undefined, ``);
    for (let i = 0; i < numArgs; i++) {
        const argV = state.scope.lookup(`arg_${i}`);
        sol.assert(argV !== undefined, ``);
        res.push(argV);
    }

    return res;
}

export const assertBuiltin = new BuiltinFunction(
    "assert",
    new BuiltinFunctionType("assert", [types.bool], []),
    (interp: Interpreter, state: State): Value[] => {
        const [flag] = getArgs(1, state);

        if (!flag) {
            throw new Assert(interp.curNode, interp.trace, ``);
        }

        return [];
    }
);

const a = new TVar("a");
const b = new TVar("b");

export const pushBuiltin = new BuiltinFunction(
    "push",
    new BuiltinFunctionType(
        "push",
        [
            new TUnion([
                new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Storage),
                new sol.PointerType(new sol.BytesType(), sol.DataLocation.Storage)
            ]),
            // Note we allow the new element type to be different from the array element type to support things like
            // arr.push("foo") since "foo" is a memory string. We handle the
            // copy inside the push() builtin. We can't do it in the caller
            // context since we don't know the exact location in storage yet.
            new TOptional(b)
        ],
        []
    ),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = getArgs(self.type.parameters.length, state);
        const arr = args[0] as ArrayStorageView | BytesStorageView;
        let el: Value;

        if (args.length > 1) {
            el = args[1];
        } else {
            const elT = arr instanceof ArrayStorageView ? arr.type.elementT : bytes1;
            el = makeZeroValue(elT, state);
        }

        if (arr instanceof ArrayStorageView) {
            const sizeView = new IntStorageView(uint256, [arr.key, arr.endOffsetInWord]);
            const curSize = sizeView.decode(state.account.storage);

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode array size`);
            }

            state.account.storage = sizeView.encode(curSize + 1n, state.account.storage);

            const elView = arr.indexView(curSize, state.account.storage);

            if (elView instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't get new element view`);
            }

            if (el !== none) {
                interp.assign(elView, el, state);
            }
        } else {
            let bytes = arr.decode(state.account.storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode bytes`);
            }

            const newByte = el instanceof Uint8Array ? el : new Uint8Array([Number(el)]);

            bytes = concatBytes(bytes, newByte);
            state.account.storage = arr.encode(bytes, state.account.storage);
        }

        return [];
    },
    true
);

export const popBuiltin = new BuiltinFunction(
    "pop",
    new BuiltinFunctionType(
        "pop",
        [
            new TUnion([
                new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Storage),
                new sol.PointerType(new sol.BytesType(), sol.DataLocation.Storage)
            ])
        ],
        []
    ),
    (interp: Interpreter, state: State): Value[] => {
        const args = getArgs(1, state);
        const arr = args[0] as ArrayStorageView | BytesStorageView;

        if (arr instanceof ArrayStorageView) {
            const sizeView = new IntStorageView(uint256, [arr.key, arr.endOffsetInWord]);
            const curSize = sizeView.decode(state.account.storage);

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode array size`);
            }

            if (curSize === 0n) {
                interp.runtimeError(EmptyArrayPop, `pop() from empty array`);
            }

            state.account.storage = sizeView.encode(curSize - 1n, state.account.storage);
            // @todo zero-out deleted element
        } else {
            const bytes = arr.decode(state.account.storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode bytes`);
            }

            if (bytes.length === 0) {
                interp.runtimeError(EmptyArrayPop, `pop() from empty array`);
            }

            state.account.storage = arr.encode(bytes.slice(0, -1), state.account.storage);
            // @todo zero-out deleted element
        }

        return [];
    },
    true
);

export const abiEncodeBuiltin = new BuiltinFunction(
    "encode",
    new BuiltinFunctionType("encode", [new TRest()], [types.bytesMemory]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.parameters;
        if (paramTs.length === 0) {
            return [new Uint8Array()];
        }

        const generalizedParamTs = paramTs.map((t) => sol.generalizeType(t)[0]);
        const args = getArgs(paramTs.length, state);
        const contract = getContract(state);

        const encBytes = encode(
            args,
            generalizedParamTs,
            state,
            contract.kind === sol.ContractKind.Library
        );

        const res = PointerMemView.allocMemFor(
            encBytes,
            types.bytesMemory.to,
            state.memAllocator
        ) as BytesMemView;
        res.encode(encBytes, state.memory);
        return [res];
    },
    false
);

export const abiDecodeBuitin = new BuiltinFunction(
    "decode",
    new BuiltinFunctionType(
        "decode",
        [types.bytesMemory, new sol.TupleType([new TRest()])],
        [new TRest()]
    ),
    (interp: Interpreter, state: State): Value[] => {
        const args = getArgs(2, state);
        const contract = getContract(state);

        interp.expect(args[0] instanceof View, ``);
        const bytes = decodeView(args[0], state);
        interp.expect(bytes instanceof Uint8Array, ``);
        interp.expect(args[1] instanceof TypeTuple);
        const typesTuple = typeValueToType(args[1]) as sol.TupleType;

        // The passed-in types here are already without memory location. However during simplification they will get
        // locations so we need to re-generalize. so we don't need to generalize.
        const types: sol.TypeNode[] = typesTuple.elements.map((t) =>
            generalizeType(simplifyType(t as sol.TypeNode, interp._infer, sol.DataLocation.Memory))
        );

        return decode(bytes, types, state, contract.kind === sol.ContractKind.Library);
    },
    false
);

export const abi = new BuiltinStruct(
    "abi",
    new sol.BuiltinStructType(
        "abi",
        new Map([
            ["encode", [[abiEncodeBuiltin.type, ">=0.4.22"]]],
            ["decode", [[abiDecodeBuitin.type, ">=0.4.22"]]]
        ])
    ),
    [
        ["encode", [[abiEncodeBuiltin, ">=0.4.22"]]],
        ["decode", [[abiDecodeBuitin, ">=0.4.22"]]]
    ]
);
