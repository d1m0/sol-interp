import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import {
    BuiltinFunction,
    BuiltinStruct,
    ExternalCallDescription,
    ExternalCallTargetValue,
    isExternalCallTarget,
    match,
    NewCall,
    none,
    TypeConstructorToValueType,
    TypeValue,
    Value,
    ValueTypeConstructors
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
    bytes1,
    bytesT,
    changeLocTo,
    decodeView,
    getMsgSender,
    getSig,
    getStateStorage,
    int256,
    liftExtCalRef,
    makeZeroValue,
    setStateStorage
} from "./utils";
import { Address, bytesToUtf8, concatBytes } from "@ethereumjs/util";
import { decode, encode, encodePacked, signatureToSelector } from "./abi";
import { MsgDataView } from "./view";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { ppValue } from "./pp";
import { satisfies } from "semver";
import { BaseInterpType, RationalNumberType } from "./types";
import { BuiltinScope, TempsScope } from "./scope";

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

function castTo(val: Value, type: BaseInterpType, state: State, interp: Interpreter): Value {
    const oldScope = state.scope;
    const temps = new TempsScope([type], state, oldScope);
    state.scope = temps;

    interp.assign(temps.temps[0], val, state);
    const res = temps.tempVals[0];
    state.scope = oldScope;

    return res;
}

function getNthArg<T extends ValueTypeConstructors>(
    n: number,
    type: BaseInterpType,
    valConstr: T,
    state: State,
    interp: Interpreter
): TypeConstructorToValueType<T> {
    const scope = state.scope as BuiltinScope;

    const rawArg = scope.lookup(`arg_${n}`);
    interp.expect(rawArg !== undefined);
    const res = castTo(rawArg, type, state, interp);
    interp.expect(match(res, valConstr));
    return res;
}

const dummyFunT = new rtt.FunctionType(
    new sol.FunctionTypeId("internal", "pure", [], [], false, false, false)
);

export const assertBuiltin = new BuiltinFunction(
    "assert",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        const flag = getNthArg(0, rtt.bool, Boolean, state, interp);

        if (!flag) {
            interp.runtimeError(AssertError, state);
        }

        return [];
    }
);

export const pushBuiltin = new BuiltinFunction(
    "push",
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const scope = state.scope as BuiltinScope;
        const args = self.getArgs(scope.nArgs, state);

        interp.expect(args.length > 0 && args.length <= 2);

        const arr = args[0];
        interp.expect(arr instanceof ArrayStorageView || arr instanceof BytesStorageView, `Expected array not ${ppValue(arr)}`);

        const elT = arr instanceof ArrayStorageView ? arr.type.elementT : bytes1;

        let el: Value;

        if (args.length > 1) {
            el = castTo(args[1], elT, state, interp);
        } else {
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
    true
);

export const popBuiltin = new BuiltinFunction(
    "pop",
    dummyFunT,
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
    true
);

function encodeImpl(
    paramTs: rtt.BaseRuntimeType[],
    args: Value[],
    state: State,
    selector?: Uint8Array
): Value {
    let encBytes: Uint8Array;

    // Replace RationalNumTypes with appropriate int type
    paramTs = paramTs.map((t) => {
        if (t instanceof RationalNumberType) {
            return t.numerator < 0 ? int256 : uint256
        }

        return t;
    })

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

function encodePackedImpl(paramTs: rtt.BaseRuntimeType[], args: Value[], state: State, ctx: sol.ASTContext): Value {
    let encBytes: Uint8Array;

    // Replace RationalNumTypes with appropriate int type
    paramTs = paramTs.map((t) => {
        if (t instanceof RationalNumberType) {
            sol.assert(t.isInt(), ``);
            const intT = sol.smallestFittingType(t.numerator);
            sol.assert(intT !== undefined, ``)
            return rtt.typeIdToRuntimeType(intT, ctx)
        }

        return t;
    })

    if (paramTs.length === 0) {
        encBytes = new Uint8Array();
    } else {
        encBytes = encodePacked(args, paramTs, state);
    }

    const res = PointerMemView.allocMemFor(encBytes, bytesT, state.memAllocator) as BytesMemView;
    res.encode(encBytes, state.memory);

    return res;
}

function getEncodeTypes(state: State): BaseInterpType[] {
    const scope = state.scope as BuiltinScope;
    const paramTs = scope.argTs.map((paramT) => {
        paramT =
            paramT instanceof RationalNumberType
                ? paramT.numerator < 0n
                    ? int256
                    : uint256
                : paramT;
        return changeLocTo(paramT, sol.DataLocation.Memory);
    });

    return paramTs;
}

export const abiEncodeBuiltin = new BuiltinFunction(
    "encode",
    //new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = getEncodeTypes(state);
        const args = self.getArgs(paramTs.length, state);
        return [encodeImpl(paramTs, args, state)];
    }
);

export const abiEncodePackedBuiltin = new BuiltinFunction(
    "encodePacked",
    //new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = getEncodeTypes(state);
        const args = self.getArgs(paramTs.length, state);
        return [encodePackedImpl(paramTs, args, state, interp.ctx)];
    }
);

export const abiEncodeWithSelectorBuiltin = new BuiltinFunction(
    "encodeWithSelector",
    //new rtt.FunctionType([rtt.bytes4, new TRest()], false, sol.FunctionStateMutability.Pure, [ memBytesT ]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = getEncodeTypes(state);
        const args = self.getArgs(paramTs.length, state);
        interp.expect(args.length >= 1, `Unexpected args to encodeWithSelector ${ppValue(args)}`);
        const selector = castTo(args[0], rtt.bytes4, state, interp);
        interp.expect(selector instanceof Uint8Array);
        return [encodeImpl(paramTs.slice(1), args.slice(1), state, selector)];
    }
);

export const abiEncodeWithSignatureBuiltin = new BuiltinFunction(
    "encodeWithSignature",
    //new rtt.FunctionType([memStringT, new TRest()], false,sol.FunctionStateMutability.Pure, [ memBytesT ]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const paramTs = getEncodeTypes(state);

        const args = self.getArgs(paramTs.length, state);

        interp.expect(args.length >= 1 && args[0] instanceof View);
        const sigStr = decodeView(args[0], state);
        interp.expect(typeof sigStr === "string");

        return [encodeImpl(paramTs.slice(1), args.slice(1), state, signatureToSelector(sigStr))];
    }
);

export const abiEncodeCallBuiltin = new BuiltinFunction(
    "encodeCall",
    //new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const scope = state.scope as BuiltinScope;
        const paramTs = scope.argTs.map((paramT) => changeLocTo(paramT, sol.DataLocation.Memory));
        const args = self.getArgs(paramTs.length, state);

        interp.expect(args.length >= 1 && args[0] instanceof rtt.ExternalFunRef);
        return [encodeImpl(paramTs.slice(1), args.slice(1), state, args[0].selector)];
    }
);

export const abiDecodeBuitin = new BuiltinFunction(
    "decode",
    //new rtt.FunctionType( [memBytesT, new rtt.TupleType([new TRest()])], false,sol.FunctionStateMutability.Pure, [new TRest()] ),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const args = self.getArgs(2, state);

        interp.expect(args[0] instanceof View, `Decode expects byte view not ${ppValue(args[0])}`);
        const bytes = decodeView(args[0], state);
        interp.expect(bytes instanceof Uint8Array, ``);
        interp.expect(args[1] instanceof TypeValue);

        const decTypes: BaseInterpType[] =
            args[1].type instanceof rtt.TupleType ? args[1].type.elementTypes : [args[1].type];
        return interp.assertNotPoison(
            state,
            decode(
                bytes,
                decTypes.map((t) => changeLocTo(t, sol.DataLocation.Memory)),
                state
            )
        );
    }
);

export const revertBuiltin = new BuiltinFunction(
    "revert",
    //new rtt.FunctionType([new TOptional(memStringT)], false, sol.FunctionStateMutability.Pure, []),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const scope = state.scope as BuiltinScope;
        const args = self.getArgs(scope.nArgs, state);

        if (args.length === 0) {
            throw new NoPayloadError(interp.curNode);
        }

        const msgArg = args[0];
        interp.expect(msgArg instanceof rtt.BytesMemView, `Unexpected arg ${ppValue(msgArg)}`);
        const msg = msgArg.decode(state.memory);
        interp.expect(msg instanceof Uint8Array);
        throw new ErrorError(interp.curNode, bytesToUtf8(msg));
    }
);

export const requireBuiltin = new BuiltinFunction(
    "require",
    //new rtt.FunctionType( [rtt.bool, new TOptional(memStringT)], false, sol.FunctionStateMutability.Pure, [] ),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const scope = state.scope as BuiltinScope;
        const args = self.getArgs(scope.nArgs, state);

        const cond = args[0];
        interp.expect(typeof cond === "boolean");
        if (cond) {
            return [];
        }

        if (args.length === 1) {
            throw new NoPayloadError(interp.curNode);
        }

        const msgArg = args[1];
        interp.expect(msgArg instanceof rtt.BytesMemView || msgArg instanceof rtt.StringMemView);
        let msg: string;

        if (msgArg instanceof BytesMemView) {
            const bs = msgArg.decode(state.memory);
            interp.expect(bs instanceof Uint8Array);
            msg = bytesToUtf8(bs)
        } else {
            const t = msgArg.decode(state.memory);
            interp.expect(typeof t === "string");
            msg = t
        }

        throw new ErrorError(interp.curNode, msg);
    }
);

export const addressBalanceBuiltin = new BuiltinFunction(
    "balance",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [uint256]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const addr = self.getArgs(1, state)[0];
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        return account === undefined ? [0n] : [account.balance];
    },
    true,
    true
);

export const addressCodeBuiltin = new BuiltinFunction(
    "code",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
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
    true,
    true
);

export const addressCodehashBuiltin = new BuiltinFunction(
    "codehash",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [bytes32]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const addr = self.getArgs(1, state)[0];
        interp.expect(addr instanceof Address);

        const account = interp.world.getAccount(addr);
        const code = account === undefined ? new Uint8Array() : account.deployedBytecode;

        return [keccak256(code)];
    },
    true,
    true
);

export const addressTransfer = new BuiltinFunction(
    "transfer",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, []),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);
        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "transfer");

        return [res];
    },
    true,
    true,
    true
);

export const addressSend = new BuiltinFunction(
    "send",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [rtt.bool]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [addr] = self.getArgs(1, state);
        interp.expect(addr instanceof Address);

        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "send");

        return [res];
    },
    true,
    true,
    true
);

export const addressCall = new BuiltinFunction(
    "call",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [rtt.bool, memBytesT ]),
    dummyFunT,
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
    true,
    true,
    true
);

export const addressDelegatecall = new BuiltinFunction(
    "delegatecall",
    //new rtt.FunctionType([addressT], false, sol.FunctionStateMutability.Pure, [    rtt.bool, memBytesT ]),
    dummyFunT,
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
    true,
    true,
    true
);

export const addressStaticcall = addressCall.alias("staticcall");

export const valueBuiltin = new BuiltinFunction(
    "value",
    //new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [target, value] = self.getArgs(2, state);
        interp.expect(isExternalCallTarget(target) && typeof value === "bigint");

        const res: ExternalCallDescription = liftExtCalRef(target);
        res.value = value;

        return [res];
    },
    true,
    false,
    false
);

export const gasBuiltin = new BuiltinFunction(
    "gas",
    //new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [callable, gas] = self.getArgs(2, state);
        interp.expect(isExternalCallTarget(callable) && typeof gas === "bigint");

        const res = liftExtCalRef(callable);
        res.gas = gas;

        return [res];
    },
    true,
    false,
    false
);

export const saltBuiltin = new BuiltinFunction(
    "salt",
    //new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [new TRest()]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [target, salt] = self.getArgs(2, state);
        interp.expect(isExternalCallTarget(target) && salt instanceof Uint8Array);

        const res = liftExtCalRef(target);
        res.salt = salt;

        return [res];
    },
    true,
    false,
    false
);

/**
 * Get the selector for an external call target
 */
function getSelector(v: ExternalCallTargetValue): Uint8Array {
    if (v instanceof rtt.ExternalFunRef) {
        return v.selector;
    }

    if (v instanceof NewCall) {
        return new Uint8Array();
    }

    sol.assert(!(v.target instanceof Address), `Can't take selector of low-level call`);
    return getSelector(v.target);
}

/**
 * Get the address of an external call target
 */
function getAddress(v: ExternalCallTargetValue): Address {
    if (v instanceof rtt.ExternalFunRef) {
        return v.address;
    }

    if (v instanceof NewCall) {
        return rtt.ZERO_ADDRESS;
    }

    if (v.target instanceof Address) {
        return v.target;
    }

    return getAddress(v.target);
}

const selectorBuiltin = new BuiltinFunction(
    "selector",
    //new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [rtt.bytes4]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [target] = self.getArgs(1, state);
        interp.expect(isExternalCallTarget(target));

        return [getSelector(target)];
    },
    true,
    true,
    true
);

const addressBuiltin = new BuiltinFunction(
    "address",
    //new rtt.FunctionType([new TRest()], true, sol.FunctionStateMutability.Pure, [addressT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [target] = self.getArgs(1, state);
        interp.expect(isExternalCallTarget(target));

        return [getAddress(target)];
    },
    true,
    true,
    true
);

// Msg struct builtins
const msgDataBuiltin = new BuiltinFunction(
    "data",
    //new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    dummyFunT,
    (): Value[] => {
        return [new MsgDataView()];
    },
    false,
    true,
    false
);

const msgValueBuiltin = new BuiltinFunction(
    "value",
    //new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [uint256]),
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.msg.value];
    },
    false,
    true,
    false
);

const msgSenderBuiltin = new BuiltinFunction(
    "sender",
    //new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [getMsgSender(state)];
    },
    false,
    true,
    false
);

const msgSigBuiltin = new BuiltinFunction(
    "sig",
    //new rtt.FunctionType([], false, sol.FunctionStateMutability.Pure, [cdBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [getSig(state)];
    },
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
    [
        [[valueBuiltin, "<=0.7.0"]],
        [[gasBuiltin, "<=0.7.0"]],
        [[saltBuiltin, "<=0.7.0"]],
        [[selectorBuiltin, ">=0.4.13"]],
        [[addressBuiltin, ">=0.4.13"]]
    ]
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

const keccak256v04Builtin = new BuiltinFunction(
    "keccak256",
    //new rtt.FunctionType([new TRest()], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const scope = state.scope as BuiltinScope;
        const args = self.getArgs(scope.nArgs, state);
        const encoded = encodePacked(args, scope.argTs, state);
        const hash = keccak256(encoded);
        return [hash];
    },
    false,
    false,
    false
);

const keccak256v05Builtin = new BuiltinFunction(
    "keccak256",
    //new rtt.FunctionType([memBytesT], false, sol.FunctionStateMutability.Pure, [memBytesT]),
    dummyFunT,
    (interp: Interpreter, state: State, self: BuiltinFunction): Value[] => {
        const [data] = self.getArgs(1, state);
        interp.expect(data instanceof View && data.type instanceof rtt.BytesType);
        return [keccak256(decodeView(data, state) as Uint8Array)];
    },
    false,
    false,
    false
);

const sha3 = keccak256v04Builtin.alias("sha3");

export const globalBuiltinStructDesc: BuiltinDescriptor = [
    "<global builtins>",
    [
        assertBuiltin,
        revertBuiltin,
        requireBuiltin,
        addressBuiltinStructDesc,
        externalCallCallableFieldsDesc,
        [[abiBuiltinStructDesc, ">=0.4.22"]],
        [[sha3, "<0.5.0"]],
        [
            [keccak256v04Builtin, "<0.5.0"],
            [keccak256v05Builtin, ">=0.5.0"]
        ],
        msgBuiltinStructDesc
    ]
];
