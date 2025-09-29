import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { BuiltinFunction, BuiltinStruct, none, TypeTuple, typeValueToType, Value } from "./value";
import { State } from "./state";
import { AssertError, EmptyArrayPopError, InternalError } from "./exceptions";
import { Interpreter } from "./interp";
import { TOptional, TRest, TUnion, TVar } from "./polymorphic";
import {
    ArrayStorageView,
    BytesMemView,
    BytesStorageView,
    DecodingFailure,
    IntStorageView,
    PointerMemView,
    uint256,
    View
} from "sol-dbg";
import { bytes1, bytesT, decodeView, getContract, makeZeroValue, memBytesT } from "./utils";
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
    new rtt.FunctionType([rtt.bool], false, sol.FunctionStateMutability.NonPayable, []),
    (interp: Interpreter, state: State): Value[] => {
        const [flag] = getArgs(1, state);

        if (!flag) {
            throw new AssertError(interp.curNode, interp.trace);
        }

        return [];
    }
);

const a = new TVar("a");
const b = new TVar("b");

export const pushBuiltin = new BuiltinFunction(
    "push",
    new rtt.FunctionType(
        [
            new TUnion([
                new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Storage),
                new rtt.PointerType(new rtt.BytesType(), sol.DataLocation.Storage)
            ]),
            // Note we allow the new element type to be different from the array element type to support things like
            // arr.push("foo") since "foo" is a memory string. We handle the
            // copy inside the push() builtin. We can't do it in the caller
            // context since we don't know the exact location in storage yet.
            new TOptional(b)
        ],
        false,
        sol.FunctionStateMutability.NonPayable,
        []
    ),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = getArgs(self.type.argTs.length, state);
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
    new rtt.FunctionType(
        [
            new TUnion([
                new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Storage),
                new rtt.PointerType(new rtt.BytesType(), sol.DataLocation.Storage)
            ])
        ],
        false,
        sol.FunctionStateMutability.NonPayable,
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
                interp.runtimeError(EmptyArrayPopError, `pop() from empty array`);
            }

            state.account.storage = sizeView.encode(curSize - 1n, state.account.storage);
            // @todo zero-out deleted element
        } else {
            const bytes = arr.decode(state.account.storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode bytes`);
            }

            if (bytes.length === 0) {
                interp.runtimeError(EmptyArrayPopError, `pop() from empty array`);
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
    new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        let encBytes: Uint8Array;

        if (paramTs.length === 0) {
            encBytes = new Uint8Array();
        } else {
            const args = getArgs(paramTs.length, state);
            const contract = getContract(state);

            encBytes = encode(args, paramTs, state, contract.kind === sol.ContractKind.Library);
        }

        const res = PointerMemView.allocMemFor(
            encBytes,
            bytesT,
            state.memAllocator
        ) as BytesMemView;
        res.encode(encBytes, state.memory);

        return [res];
    },
    false
);

export const abiDecodeBuitin = new BuiltinFunction(
    "decode",
    new rtt.FunctionType(
        [memBytesT, new rtt.TupleType([new TRest()])],
        false,
        sol.FunctionStateMutability.Pure,
        [new TRest()]
    ),
    (interp: Interpreter, state: State): Value[] => {
        const args = getArgs(2, state);

        interp.expect(args[0] instanceof View, ``);
        const bytes = decodeView(args[0], state);
        interp.expect(bytes instanceof Uint8Array, ``);
        interp.expect(args[1] instanceof TypeTuple);
        const typesTuple = typeValueToType(args[1]);

        sol.assert(typesTuple instanceof rtt.TupleType, ``);
        return decode(
            bytes,
            typesTuple.elementTypes.map((t) => rtt.specializeType(t, sol.DataLocation.Memory)),
            state
        );
    },
    false
);

export const abi = new BuiltinStruct(
    "abi",
    new rtt.StructType("abi", [
        ["encode", abiEncodeBuiltin.type],
        ["decode", abiDecodeBuitin.type]
    ]),
    [
        ["encode", [[abiEncodeBuiltin, ">=0.4.22"]]],
        ["decode", [[abiDecodeBuitin, ">=0.4.22"]]]
    ]
);
