import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import {
    BuiltinFunction,
    BuiltinStruct,
    ExternalCallDescription,
    NewCall,
    none,
    TypeTuple,
    typeValueToType,
    Value
} from "./value";
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
    cdBytesT,
    decodeView,
    getMsgSender,
    getSig,
    getStateStorage,
    liftExtCalRef,
    makeZeroValue,
    memBytesT,
    memStringT,
    setStateStorage
} from "./utils";
import { Address, concatBytes } from "@ethereumjs/util";
import { decode, encode, signatureToSelector } from "./abi";
import { MsgDataView } from "./view";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { ppValue } from "./pp";
import { satisfies } from "semver";

/**
 * A version-dependent buitlin description. This is a recursive datatype with several cases:
 * - a concrete builtin function
 * - a concrete builtin struct
 * - [BuiltinDescriptor, string][] a  choice from multiple builtin descriptors for different version ranges
 *  - [string, BuiltinDescriptor[]]- a builtin struct whose field types depend on the version
 */
export type BuiltinDescriptor =
    | BuiltinFunction
    | BuiltinStruct
    | Array<[BuiltinDescriptor, string]>
    | [string, BuiltinDescriptor[]];

/**
 * Given a builtin descriptor and a version return the concrete builtin for that versio
 */
export function makeBuiltin(
    descriptor: BuiltinDescriptor,
    version: string
): BuiltinFunction | BuiltinStruct | undefined {
    if (descriptor instanceof BuiltinFunction || descriptor instanceof BuiltinStruct) {
        return descriptor;
    }

    // Version-dependent struct description
    if (typeof descriptor[0] === "string") {
        const name = descriptor[0];
        const fields = (descriptor[1] as BuiltinDescriptor[])
            .map((desc) => makeBuiltin(desc, version))
            .filter((field) => field !== undefined);

        const structT = new rtt.StructType(
            name,
            fields.map((field) => [field.name, field.type])
        );
        return new BuiltinStruct(
            descriptor[0],
            structT,
            fields.map((field) => [field.name, field])
        );
    }

    // A choice of several options
    const matchingOptions = (descriptor as Array<[BuiltinDescriptor, string]>).filter(
        ([, verPattern]) => satisfies(version, verPattern)
    );

    if (matchingOptions.length === 0) {
        return undefined;
    }

    sol.assert(
        matchingOptions.length === 1,
        `Multiple matching fields for version ${version} for descriptor ${descriptor}`
    );

    return makeBuiltin(matchingOptions[0][0], version);
}

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

function encodeImpl(
    self: BuiltinFunction,
    paramTs: rtt.BaseRuntimeType[],
    args: Value[],
    state: State,
    selector?: Uint8Array
): Value {
    let encBytes: Uint8Array;

    if (paramTs.length === 0) {
        encBytes = new Uint8Array();
    } else {
        encBytes = encode(args, paramTs, state);
    }

    if (selector) {
        encBytes = concatBytes(selector, encBytes);
    }

    const res = PointerMemView.allocMemFor(encBytes, bytesT, state.memAllocator) as BytesMemView;
    res.encode(encBytes, state.memory);

    return res;
}

export const abiEncodeBuiltin = new BuiltinFunction(
    "encode",
    new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        const args = self.getArgs(paramTs.length, state);
        return [encodeImpl(self, paramTs, args, state)];
    }
);

export const abiEncodePackedBuiltin = new BuiltinFunction(
    "encodePacked",
    new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        rtt.nyi(`encodePacked(${paramTs.map((t) => t.pp()).join(", ")})`);
    }
);

export const abiEncodeWithSelectorBuiltin = new BuiltinFunction(
    "encodeWithSelector",
    new rtt.FunctionType([rtt.bytes4, new TRest()], false, sol.FunctionStateMutability.Pure, [
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        const args = self.getArgs(paramTs.length, state);

        interp.expect(args.length >= 1 && args[0] instanceof Uint8Array);
        return [encodeImpl(self, paramTs.slice(1), args.slice(1), state, args[0])];
    }
);

export const abiEncodeWithSignatureBuiltin = new BuiltinFunction(
    "encodeWithSignature",
    new rtt.FunctionType([memStringT, new TRest()], false, sol.FunctionStateMutability.Pure, [
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        const args = self.getArgs(paramTs.length, state);

        interp.expect(args.length >= 1 && args[0] instanceof View);
        const sigStr = decodeView(args[0], state);
        interp.expect(typeof sigStr === "string");

        return [
            encodeImpl(self, paramTs.slice(1), args.slice(1), state, signatureToSelector(sigStr))
        ];
    }
);

export const abiEncodeCallBuiltin = new BuiltinFunction(
    "encodeCall",
    new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = self.type.argTs;
        const args = self.getArgs(paramTs.length, state);

        interp.expect(args.length >= 1 && args[0] instanceof rtt.ExternalFunRef);
        return [encodeImpl(self, paramTs.slice(1), args.slice(1), state, args[0].selector)];
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

        interp.expect(args[0] instanceof View, `Decode expects byte view not ${ppValue(args[0])}`);
        const bytes = decodeView(args[0], state);
        interp.expect(bytes instanceof Uint8Array, ``);
        interp.expect(args[1] instanceof TypeTuple);
        const typesTuple = typeValueToType(args[1]);

        sol.assert(typesTuple instanceof rtt.TupleType, ``);
        return interp.assertNotPoison(
            state,
            decode(
                bytes,
                typesTuple.elementTypes.map((t) => rtt.specializeType(t, sol.DataLocation.Memory)),
                state
            )
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

        const codeView = PointerMemView.allocMemFor(code, bytesT, state.memAllocator);
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

        return [keccak256(code)];
    },
    [],
    [],
    true,
    true
);

export const addressTransfer = new BuiltinFunction(
    "transfer",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, []),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);
        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "transfer");

        return [res];
    },
    [],
    [],
    true,
    true,
    true
);

export const addressSend = new BuiltinFunction(
    "send",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [rtt.bool]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);

        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "send");

        return [res];
    },
    [],
    [],
    true,
    true,
    true
);

export const addressCall = new BuiltinFunction(
    "call",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [
        rtt.bool,
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);

        const res = new ExternalCallDescription(
            addr,
            undefined,
            undefined,
            undefined,
            self.name as "call" | "staticcall"
        );

        return [res];
    },
    [],
    [],
    true,
    true,
    true
);

export const addressDelegatecall = new BuiltinFunction(
    "delegatecall",
    new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [
        rtt.bool,
        memBytesT
    ]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);

        const res = new ExternalCallDescription(
            addr,
            undefined,
            undefined,
            undefined,
            "delegatecall"
        );

        return [res];
    },
    [],
    [],
    true,
    true,
    true
);

export const addressStaticcall = addressCall.alias("staticcall");

export const valueBuiltin = new BuiltinFunction(
    "value",
    new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [callable, value] = self.getArgs(2, state);
        interp.expect(
            callable instanceof rtt.ExternalFunRef ||
                callable instanceof ExternalCallDescription ||
                callable instanceof NewCall
        );
        interp.expect(typeof value === "bigint");

        const res: ExternalCallDescription = liftExtCalRef(callable);
        res.value = value;

        return [res];
    },
    [],
    [],
    true,
    false,
    false
);

export const gasBuiltin = new BuiltinFunction(
    "gas",
    new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [callable, gas] = self.getArgs(2, state);
        interp.expect(
            callable instanceof rtt.ExternalFunRef ||
                callable instanceof ExternalCallDescription ||
                callable instanceof NewCall
        );
        interp.expect(typeof gas === "bigint");

        const res = liftExtCalRef(callable);
        res.gas = gas;

        return [res];
    },
    [],
    [],
    true,
    false,
    false
);

export const saltBuiltin = new BuiltinFunction(
    "salt",
    new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [callable, salt] = self.getArgs(2, state);
        interp.expect(
            callable instanceof rtt.ExternalFunRef ||
                callable instanceof ExternalCallDescription ||
                callable instanceof NewCall
        );
        interp.expect(salt instanceof Uint8Array);

        const res = liftExtCalRef(callable);
        res.salt = salt;

        return [res];
    },
    [],
    [],
    true,
    false,
    false
);

// Msg struct builtins
const msgDataBuiltin = new BuiltinFunction(
    "data",
    new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    (): Value[] => {
        return [new MsgDataView()];
    },
    [],
    [],
    false,
    true,
    false
);

const msgValueBuiltin = new BuiltinFunction(
    "value",
    new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [uint256]),
    (interp: Interpreter, state: State): Value[] => {
        return [state.msg.value];
    },
    [],
    [],
    false,
    true,
    false
);

const msgSenderBuiltin = new BuiltinFunction(
    "sender",
    new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    (interp: Interpreter, state: State): Value[] => {
        return [getMsgSender(state)];
    },
    [],
    [],
    false,
    true,
    false
);

const msgSigBuiltin = new BuiltinFunction(
    "sig",
    new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    (interp: Interpreter, state: State): Value[] => {
        return [getSig(state)];
    },
    [],
    [],
    false,
    true,
    false
);

const msgBuiltinStructDesc: BuiltinDescriptor = [
    "msg",
    [msgDataBuiltin, msgValueBuiltin, msgSenderBuiltin, msgSigBuiltin]
];

export const EXTERNAL_CALL_CALLABLE_FIELDS_NAME = "<external call callable fields>";

const externalCallCallableFieldsDesc: BuiltinDescriptor = [
    EXTERNAL_CALL_CALLABLE_FIELDS_NAME,
    [[[valueBuiltin, "<=0.7.0"]], [[gasBuiltin, "<=0.7.0"]], [[saltBuiltin, "<=0.7.0"]]]
];

export const ADDRESS_BUILTIN_STRUCT_NAME = "<address builtins>";

const addressBuiltinStructDesc: BuiltinDescriptor = [
    ADDRESS_BUILTIN_STRUCT_NAME,
    [
        [[addressBalanceBuiltin, ">=0.4.13"]],
        [[addressCodeBuiltin, ">=0.8.0"]],
        [[addressCodehashBuiltin, ">=0.8.0"]],
        [[addressTransfer, ">=0.4.13"]],
        [[addressSend, ">=0.4.13"]],
        [[addressCall, ">=0.4.13"]],
        [[addressDelegatecall, ">=0.4.13"]],
        [[addressStaticcall, ">=0.5.0"]]
    ]
];

const abiBuiltinStructDesc: BuiltinDescriptor = [
    "abi",
    [
        [[abiEncodeBuiltin, ">=0.4.22"]],
        [[abiDecodeBuitin, ">=0.4.22"]],
        [[abiEncodePackedBuiltin, ">=0.4.22"]],
        [[abiEncodeWithSelectorBuiltin, ">=0.4.22"]],
        [[abiEncodeWithSignatureBuiltin, ">=0.4.22"]],
        [[abiEncodeCallBuiltin, ">=0.8.11"]]
    ]
];

export const globalBuiltinStructDesc: BuiltinDescriptor = [
    "<global builtins>",
    [
        assertBuiltin,
        revertBuiltin,
        requireBuiltin,
        addressBuiltinStructDesc,
        externalCallCallableFieldsDesc,
        [[abiBuiltinStructDesc, ">=0.4.22"]],
        msgBuiltinStructDesc
    ]
];
