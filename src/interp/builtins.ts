import { BuiltinFunctionType, types } from "solc-typed-ast";
import * as sol from "solc-typed-ast";
import { BuiltinFunction, none, Value } from "./value";
import { State } from "./state";
import { Assert, EmptyArrayPop, InternalError } from "./exceptions";
import { Interpreter } from "./interp";
import { TOptional, TUnion, TVar } from "./polymorphic";
import {
    ArrayStorageView,
    BytesStorageView,
    DecodingFailure,
    IntStorageView,
    uint256
} from "sol-dbg";
import { bytes1, makeZeroValue } from "./utils";
import { concatBytes } from "@ethereumjs/util";

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
    (interp: Interpreter, state: State, nArgs): Value[] => {
        const args = getArgs(nArgs, state);
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
            const curSize = sizeView.decode(state.storage);

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode array size`);
            }

            state.storage = sizeView.encode(curSize + 1n, state.storage);

            const elView = arr.indexView(curSize, state.storage);

            if (elView instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't get new element view`);
            }

            if (el !== none) {
                interp.assign(elView, el, state);
            }
        } else {
            let bytes = arr.decode(state.storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode bytes`);
            }

            const newByte = el instanceof Uint8Array ? el : new Uint8Array([Number(el)]);

            bytes = concatBytes(bytes, newByte);
            state.storage = arr.encode(bytes, state.storage);
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
            const curSize = sizeView.decode(state.storage);

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode array size`);
            }

            if (curSize === 0n) {
                interp.runtimeError(EmptyArrayPop, `pop() from empty array`);
            }

            state.storage = sizeView.encode(curSize - 1n, state.storage);
            // @todo zero-out deleted element
        } else {
            const bytes = arr.decode(state.storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode bytes`);
            }

            if (bytes.length === 0) {
                interp.runtimeError(EmptyArrayPop, `pop() from empty array`);
            }

            state.storage = arr.encode(bytes.slice(0, -1), state.storage);
            // @todo zero-out deleted element
        }

        return [];
    },
    true
);
