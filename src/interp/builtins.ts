import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { BuiltinFunction, BuiltinStruct, none, TypeTuple, typeValueToType, Value } from "./value";
import { State } from "./state";
import {
    AssertError,
    EmptyArrayPopError,
    ErrorError,
    InternalError,
    NoPayloadError
} from "./exceptions";
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
import {
    addressT,
    bytes1,
    bytes32,
    bytesT,
    decodeView,
    getMsgSender,
    getSig,
    getStateStorage,
    makeZeroValue,
    memBytesT,
    memStringT,
    setStateStorage
} from "./utils";
import { Address, concatBytes } from "@ethereumjs/util";
import { decode, encode } from "./abi";
import { MsgDataView } from "./view";
import { keccak256 } from "ethereum-cryptography/keccak.js";

export const assertBuiltin = new BuiltinFunction(
    "assert",
    new rtt.FunctionType([rtt.bool], false, sol.FunctionStateMutability.NonPayable, []),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [flag] = self.getArgs(1, state);

        if (!flag) {
            interp.runtimeError(AssertError, state);
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
        const args = self.getArgs(self.type.argTs.length, state);
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
            const curSize = sizeView.decode(getStateStorage(state));

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode array size`);
            }

            const newStorage = sizeView.encode(curSize + 1n, getStateStorage(state));
            setStateStorage(state, newStorage);

            const elView = arr.indexView(curSize, newStorage);

            if (elView instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't get new element view`);
            }

            if (el !== none) {
                interp.assign(elView, el, state);
            }
        } else {
            const storage = getStateStorage(state);
            let bytes = arr.decode(storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `push(): couldn't decode bytes`);
            }

            const newByte = el instanceof Uint8Array ? el : new Uint8Array([Number(el)]);

            bytes = concatBytes(bytes, newByte);
            setStateStorage(state, arr.encode(bytes, storage));
        }

        return [];
    },
    [],
    [],
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
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = self.getArgs(1, state);
        const arr = args[0] as ArrayStorageView | BytesStorageView;

        if (arr instanceof ArrayStorageView) {
            const sizeView = new IntStorageView(uint256, [arr.key, arr.endOffsetInWord]);
            const storage = getStateStorage(state);
            const curSize = sizeView.decode(storage);

            if (curSize instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode array size`);
            }

            if (curSize === 0n) {
                interp.runtimeError(EmptyArrayPopError, state);
            }

            setStateStorage(state, sizeView.encode(curSize - 1n, storage));
            // @todo zero-out deleted element
        } else {
            const storage = getStateStorage(state);
            const bytes = arr.decode(storage);

            if (bytes instanceof DecodingFailure) {
                interp.fail(InternalError, `pop(): couldn't decode bytes`);
            }

            if (bytes.length === 0) {
                interp.runtimeError(EmptyArrayPopError, state);
            }

            setStateStorage(state, arr.encode(bytes.slice(0, -1), storage));
            // @todo zero-out deleted element
        }

        return [];
    },
    [],
    [],
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
            const args = self.getArgs(paramTs.length, state);
            encBytes = encode(args, paramTs, state);
        }

        const res = PointerMemView.allocMemFor(
            encBytes,
            bytesT,
            state.memAllocator
        ) as BytesMemView;
        res.encode(encBytes, state.memory);

        return [res];
    }
);

export const abiDecodeBuitin = new BuiltinFunction(
    "decode",
    new rtt.FunctionType(
        [memBytesT, new rtt.TupleType([new TRest()])],
        false,
        sol.FunctionStateMutability.Pure,
        [new TRest()]
    ),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = self.getArgs(2, state);

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
    }
);

export const revertBuiltin = new BuiltinFunction(
    "revert",
    new rtt.FunctionType([new TOptional(memStringT)], false, sol.FunctionStateMutability.Pure, []),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = self.getArgs(self.type.argTs.length, state);

        if (args.length === 0) {
            throw new NoPayloadError(interp.curNode);
        }

        const msgArg = args[0];
        interp.expect(msgArg instanceof rtt.StringMemView);
        const msg = msgArg.decode(state.memory);
        interp.expect(typeof msg === "string");
        throw new ErrorError(interp.curNode, msg);
    }
);

export const requireBuiltin = new BuiltinFunction(
    "require",
    new rtt.FunctionType(
        [rtt.bool, new TOptional(memStringT)],
        false,
        sol.FunctionStateMutability.Pure,
        []
    ),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = self.getArgs(self.type.argTs.length, state);

        const cond = args[0];
        interp.expect(typeof cond === "boolean");
        if (cond) {
            return [];
        }

        if (args.length === 1) {
            throw new NoPayloadError(interp.curNode);
        }

        const msgArg = args[1];
        interp.expect(msgArg instanceof rtt.StringMemView);
        const msg = msgArg.decode(state.memory);
        interp.expect(typeof msg === "string");
        throw new ErrorError(interp.curNode, msg);
    }
);

const abiType = new rtt.StructType("abi", [
    ["encode", abiEncodeBuiltin.type],
    ["decode", abiDecodeBuitin.type]
]);

export const abi = new BuiltinStruct("abi", abiType, [
    ["encode", [[abiEncodeBuiltin, ">=0.4.22"]]],
    ["decode", [[abiDecodeBuitin, ">=0.4.22"]]]
]);

const msgType = new rtt.StructType("msg", [
    ["data", new rtt.PointerType(bytesT, sol.DataLocation.CallData)],
    ["sender", new rtt.AddressType()],
    ["sig", rtt.bytes4],
    ["value", rtt.uint256]
]);

export function makeMsgBuiltin(state: State): BuiltinStruct {
    return new BuiltinStruct("msg", msgType, [
        ["data", [[new MsgDataView(), ">=0.4.13"]]],
        ["sender", [[getMsgSender(state), ">=0.4.13"]]],
        ["sig", [[getSig(state), ">=0.4.13"]]],
        ["value", [[state.msg.value, ">=0.4.13"]]]
    ]);
}

const transferT = new rtt.FunctionType([uint256], true, sol.FunctionStateMutability.Payable, []);
const sendT = new rtt.FunctionType([uint256], true, sol.FunctionStateMutability.Payable, [
    rtt.bool
]);
const callT = new rtt.FunctionType([memBytesT], true, sol.FunctionStateMutability.Payable, [
    rtt.bool,
    memBytesT
]);

const addressStructType = new rtt.StructType("address", [
    ["balance", uint256],
    ["code", memBytesT],
    ["codehash", bytes32],
    ["transfer", transferT],
    ["send", sendT],
    ["call", callT],
    ["delegatecall", callT],
    ["staticcall", callT]
]);

export const addressBalanceBuiltin = new BuiltinFunction(
    "balance",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [uint256]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const addr = self.getArgs(1, state)[0];
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        return account === undefined ? [0n] : [account.balance];
    },
    [],
    [],
    true,
    true
);

export const addressCodeBuiltin = new BuiltinFunction(
    "code",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const addr = self.getArgs(1, state)[0];
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        const code = account === undefined ? new Uint8Array() : account.deployedBytecode;

        const codeView = PointerMemView.allocMemFor(code, memBytesT, state.memAllocator);
        codeView.encode(code, state.memory, state.memAllocator);

        //@todo implement code === 0x0 during contract initialization
        return [codeView];
    },
    [],
    [],
    true,
    true
);

export const addressCodehashBuiltin = new BuiltinFunction(
    "codehash",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [bytes32]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const addr = self.getArgs(1, state)[0];
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        const code = account === undefined ? new Uint8Array() : account.deployedBytecode;

        //@todo implement code === 0x0 during contract initialization
        return [keccak256(code)];
    },
    [],
    [],
    true,
    true
);

export const addressTransfer = new BuiltinFunction(
    "transfer",
    new rtt.FunctionType([addressT, uint256], false, sol.FunctionStateMutability.Pure, []),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr, amount] = self.getArgs(2, state);
        interp.expect(addr instanceof Address);
        interp.expect(typeof amount === "bigint");

        const account = interp.world.getAccount(addr);
        rtt.nyi(`transfer(${account}, ${amount})`);
    },
    [],
    [],
    true,
    true
);

export const addressSend = new BuiltinFunction(
    "send",
    new rtt.FunctionType([addressT, uint256], false, sol.FunctionStateMutability.Pure, [rtt.bool]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr, amount] = self.getArgs(2, state);
        interp.expect(addr instanceof Address);
        interp.expect(typeof amount === "bigint");

        const account = interp.world.getAccount(addr);
        rtt.nyi(`send(${account}, ${amount})`);
    },
    [],
    [],
    true,
    true
);

export const addressCall = new BuiltinFunction(
    "call",
    new rtt.FunctionType([addressT, memBytesT], false, sol.FunctionStateMutability.Pure, [
        rtt.bool,
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr, msg] = self.getArgs(2, state);
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        rtt.nyi(`call(${account}, ${msg})`);
    },
    [],
    [],
    true,
    true
);

export const addressDelegatecall = new BuiltinFunction(
    "delegatecall",
    new rtt.FunctionType([addressT, memBytesT], false, sol.FunctionStateMutability.Pure, [
        rtt.bool,
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr, msg] = self.getArgs(2, state);
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        rtt.nyi(`delegatecall(${account}, ${msg})`);
    },
    [],
    [],
    true,
    true
);

export const addressStaticcall = addressCall.alias("staticcall");

export const addressBuiltinStruct = new BuiltinStruct("address", addressStructType, [
    ["balance", [[addressBalanceBuiltin, ">=0.4.13"]]],
    ["code", [[addressCodeBuiltin, ">=0.4.13"]]],
    ["codehash", [[addressCodeBuiltin, ">=0.4.13"]]],
    ["transfer", [[addressTransfer, ">=0.4.13"]]],
    ["send", [[addressSend, ">=0.4.13"]]],
    ["call", [[addressCall, ">=0.4.13"]]],
    ["delegatecall", [[addressDelegatecall, ">=0.4.13"]]],
    ["staticcall", [[addressStaticcall, ">=0.4.13"]]]
]);
