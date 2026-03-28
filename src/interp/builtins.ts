import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import {
    BuiltinFunction,
    BuiltinStruct,
    ExternalCallDescription,
    ExternalCallTargetValue,
    isExternalCallTarget,
    LengthView,
    NewCall,
    TypeValue,
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
import {
    ArrayStorageView,
    BytesMemView,
    BytesStorageView,
    DecodingFailure,
    PointerMemView,
    uint256,
    View
} from "sol-dbg";
import {
    bytesT,
    changeLocTo,
    decodeView,
    getMsgSender,
    getSig,
    getStateStorage,
    int256,
    isValueType,
    liftExtCalRef,
    memBytesT,
    memStringT,
    stringT
} from "./utils";
import {
    Address,
    bytesToUtf8,
    concatBytes,
    createAddressFromPublicKey,
    ecrecover
} from "@ethereumjs/util";
import { decode, encode, encodePacked, signatureToSelector } from "./abi";
import { MsgDataView } from "./view";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { ppValue } from "./pp";
import { lt, satisfies } from "semver";
import { BaseInterpType, RationalNumberType, typeIdToRuntimeType, WrappedType } from "./types";
import { xor } from "./bitwise";

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

const dummyFunT = new rtt.FunctionType(
    new sol.FunctionTypeId("internal", "pure", [], [], false, false, false)
);

export const assertBuiltin = new BuiltinFunction(
    "assert",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1);
        const flag = interp.castTo(args[0], rtt.bool, state);

        if (!flag) {
            if (lt(interp.compilerVersion, "0.8.0")) {
                interp.runtimeError(NoPayloadError, state);
            } else {
                interp.runtimeError(AssertError, state);
            }
        }

        return [];
    }
);

export const pushPre06Builtin = new BuiltinFunction(
    "push",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length > 0 && args.length <= 2);

        const arr = args[0];
        interp.expect(
            arr instanceof ArrayStorageView || arr instanceof BytesStorageView,
            `Expected array not ${ppValue(arr)}`
        );
        const newEl = args.length > 1 ? args[1] : undefined;
        interp.pushImpl(arr, newEl, state);
        return [arr.size(getStateStorage(state))];
    },
    true
);

export const push06Builtin = new BuiltinFunction(
    "push",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length > 0 && args.length <= 2);

        const arr = args[0];
        interp.expect(
            arr instanceof ArrayStorageView || arr instanceof BytesStorageView,
            `Expected array not ${ppValue(arr)}`
        );
        const newEl = args.length > 1 ? args[1] : undefined;
        const newElView = interp.pushImpl(arr, newEl, state);
        return [
            isValueType(newElView.type)
                ? (decodeView(newElView, state) as rtt.PrimitiveValue)
                : newElView
        ];
    },
    true
);

export const popBuiltin = new BuiltinFunction(
    "pop",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(
            args.length === 1 &&
                (args[0] instanceof ArrayStorageView || args[0] instanceof BytesStorageView)
        );
        const arr = args[0];
        const curSize = arr.size(getStateStorage(state));

        if (curSize instanceof DecodingFailure) {
            interp.fail(InternalError, `pop(): couldn't decode array size`);
        }

        if (curSize === 0n) {
            interp.runtimeError(EmptyArrayPopError, state);
        }

        interp.resizeStorageArray(new LengthView(arr), curSize - 1n, state);
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

function encodePackedImpl(paramTs: rtt.BaseRuntimeType[], args: Value[], state: State): Value {
    let encBytes: Uint8Array;

    if (paramTs.length === 0) {
        encBytes = new Uint8Array();
    } else {
        encBytes = encodePacked(args, paramTs, state);
    }

    const res = PointerMemView.allocMemFor(encBytes, bytesT, state.memAllocator) as BytesMemView;
    res.encode(encBytes, state.memory);

    return res;
}

function getEncodeTypes(
    argTs: BaseInterpType[],
    ctx: sol.ASTContext,
    isPacked: boolean
): BaseInterpType[] {
    const paramTs = argTs.map((paramT) => {
        if (paramT instanceof RationalNumberType) {
            sol.assert(paramT.isInt(), ``);
            if (isPacked) {
                const intT = sol.smallestFittingType(paramT.numerator);
                sol.assert(intT !== undefined, ``);
                return rtt.typeIdToRuntimeType(new sol.IntTypeId(intT.nBits, intT.signed), ctx);
            } else {
                return paramT.numerator < 0n ? int256 : uint256;
            }
        }

        return changeLocTo(paramT, sol.DataLocation.Memory);
    });

    return paramTs;
}

export const abiEncodeBuiltin = new BuiltinFunction(
    "encode",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const paramTs = getEncodeTypes(argTs, interp.ctx, false);
        return [encodeImpl(paramTs, args, state)];
    }
);

export const abiEncodePackedBuiltin = new BuiltinFunction(
    "encodePacked",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const paramTs = getEncodeTypes(argTs, interp.ctx, true);
        return [encodePackedImpl(paramTs, args, state)];
    }
);

export const abiEncodeWithSelectorBuiltin = new BuiltinFunction(
    "encodeWithSelector",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const paramTs = getEncodeTypes(argTs, interp.ctx, false);
        interp.expect(args.length >= 1, `Unexpected args to encodeWithSelector ${ppValue(args)}`);
        const selector = interp.castTo(args[0], rtt.bytes4, state);
        interp.expect(selector instanceof Uint8Array);
        return [encodeImpl(paramTs.slice(1), args.slice(1), state, selector)];
    }
);

export const abiEncodeWithSignatureBuiltin = new BuiltinFunction(
    "encodeWithSignature",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const paramTs = getEncodeTypes(argTs, interp.ctx, false);
        interp.expect(args.length >= 1 && args[0] instanceof View);
        const sigStr = decodeView(args[0], state);
        interp.expect(sigStr instanceof Uint8Array, `Unexpected signature ${sigStr}`);

        return [
            encodeImpl(
                paramTs.slice(1),
                args.slice(1),
                state,
                signatureToSelector(bytesToUtf8(sigStr))
            )
        ];
    }
);

export const abiEncodeCallBuiltin = new BuiltinFunction(
    "encodeCall",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const paramTs = getEncodeTypes(argTs, interp.ctx, false);

        interp.expect(args.length >= 1 && args[0] instanceof rtt.ExternalFunRef);
        return [encodeImpl(paramTs.slice(1), args.slice(1), state, args[0].selector)];
    }
);

export const abiDecodeBuitin = new BuiltinFunction(
    "decode",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 2);
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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        if (args.length === 0) {
            interp.runtimeError(NoPayloadError, state);
        }

        interp.expect(
            args.length === 1 && args[0] instanceof rtt.BytesMemView,
            `Unexpected arg ${ppValue(args[0])}`
        );
        const msgArg = args[0];
        const msg = msgArg.decode(state.memory);
        interp.expect(msg instanceof Uint8Array);
        interp.runtimeError(ErrorError, state, bytesToUtf8(msg));
    }
);

export const requireBuiltin = new BuiltinFunction(
    "require",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length >= 1 && args.length <= 2);
        const flag = interp.castTo(args[0], rtt.bool, state);
        interp.expect(typeof flag === "boolean");

        if (flag) {
            return [];
        }

        if (args.length === 1) {
            interp.runtimeError(NoPayloadError, state);
        }

        interp.expect(args[1] instanceof rtt.BytesMemView);
        const bs = args[1].decode(state.memory);
        interp.expect(bs instanceof Uint8Array);

        interp.runtimeError(ErrorError, state, bytesToUtf8(bs));
    }
);

export const addressBalanceBuiltin = new BuiltinFunction(
    "balance",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

        const account = interp.world.getAccount(addr);
        return account === undefined ? [0n] : [account.balance];
    },
    true,
    true
);

export const addressCodeBuiltin = new BuiltinFunction(
    "code",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

        const account = interp.world.getAccount(addr);
        const code = account === undefined ? new Uint8Array() : account.deployedBytecode;

        return [keccak256(code)];
    },
    true,
    true
);

export const addressTransfer = new BuiltinFunction(
    "transfer",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];
        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "transfer");

        return [res];
    },
    true,
    true,
    true
);

export const addressSend = new BuiltinFunction(
    "send",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

        const res = new ExternalCallDescription(addr, undefined, undefined, undefined, "send");

        return [res];
    },
    true,
    true,
    true
);

export const addressCall = new BuiltinFunction(
    "call",
    dummyFunT,
    (
        interp: Interpreter,
        state: State,
        args: Value[],
        argTs: BaseInterpType[],
        self: BuiltinFunction
    ): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && args[0] instanceof Address);
        const addr = args[0];

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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 2);
        const [target, value] = args;
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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 2);
        const [target, gas] = args;
        interp.expect(isExternalCallTarget(target) && typeof gas === "bigint");

        const res = liftExtCalRef(target);
        res.gas = gas;

        return [res];
    },
    true,
    false,
    false
);

export const saltBuiltin = new BuiltinFunction(
    "salt",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 2);
        const [target, salt] = args;
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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && isExternalCallTarget(args[0]));
        const [target] = args;
        return [getSelector(target)];
    },
    true,
    true,
    true
);

const addressBuiltin = new BuiltinFunction(
    "address",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(args.length === 1 && isExternalCallTarget(args[0]));
        const [target] = args;

        return [getAddress(target)];
    },
    true,
    true,
    true
);

// Msg struct builtins
const msgDataBuiltin = new BuiltinFunction(
    "data",
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
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[], argTs: BaseInterpType[]): Value[] => {
        const encTs = getEncodeTypes(argTs, interp.ctx, true);
        const encoded = encodePacked(args, encTs, state);
        const hash = keccak256(encoded);
        return [hash];
    },
    false,
    false,
    false
);

const keccak256v05Builtin = new BuiltinFunction(
    "keccak256",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(
            args.length === 1 && args[0] instanceof View,
            `keccak256 expects a bytes array as argument`
        );
        const bytes = decodeView(args[0], state);
        interp.expect(bytes instanceof Uint8Array, `keccak256 expects a bytes array as argument`);
        const res = keccak256(bytes);
        return [res];
    },
    false,
    false,
    false
);

const sha3 = keccak256v04Builtin.alias("sha3");

function interfaceId(contract: sol.ContractDefinition): Uint8Array {
    sol.assert(
        contract.kind === sol.ContractKind.Interface ||
            (contract.kind === sol.ContractKind.Contract && contract.abstract),
        ``
    );
    const selectors: Uint8Array[] = contract.vFunctions.map((funDef) => sol.signatureHash(funDef));

    for (const v of contract.vStateVariables) {
        if (v.visibility === sol.StateVariableVisibility.Public) {
            selectors.push(sol.signatureHash(v));
        }
    }
    return selectors.reduce((x, y) => xor(x, y));
}

const typeBuiltin = new BuiltinFunction(
    "type",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(
            args.length === 1 &&
                args[0] instanceof TypeValue &&
                args[0].type instanceof WrappedType &&
                args[0].type.innerT instanceof sol.TypeTypeId,
            `keccak256 expects a bytes array as argument`
        );

        const solT = args[0].type.innerT.actualT;
        const name = `<${solT.pp()} type info>`;
        const curNode = interp.curNode;
        interp.expect(curNode instanceof sol.ASTNode);
        const ctx = curNode.requiredContext;

        if (solT instanceof sol.IntTypeId) {
            const rtT = typeIdToRuntimeType(solT, ctx) as rtt.IntType;
            const structT = new rtt.StructType(name, [
                ["min", rtT],
                ["max", rtT]
            ]);
            return [
                new BuiltinStruct(name, structT, [
                    ["min", rtT.min()],
                    ["max", rtT.max()]
                ])
            ];
        }

        if (solT instanceof sol.ContractTypeId) {
            const contract = ctx.locate(solT.id);
            interp.expect(contract instanceof sol.ContractDefinition);

            const fields: Array<[string, BaseInterpType]> = [["name", memStringT]];

            const nameView = PointerMemView.allocMemFor(
                contract.name,
                stringT,
                state.memAllocator
            ) as BytesMemView;
            nameView.encodeStr(contract.name, state.memory);

            const vals: Array<[string, Value]> = [["name", nameView]];

            const artifact = interp.artifactManager.getContractInfo(contract);
            interp.expect(artifact !== undefined);

            const bytecodeInfo = artifact.bytecode;
            const deployedBytecodeInfo = artifact.deployedBytecode;

            if (bytecodeInfo !== undefined && deployedBytecodeInfo !== undefined) {
                const creationCodeView = PointerMemView.allocMemFor(
                    bytecodeInfo.bytecode,
                    bytesT,
                    state.memAllocator
                ) as BytesMemView;
                creationCodeView.encode(bytecodeInfo.bytecode, state.memory);

                const runtimeCodeView = PointerMemView.allocMemFor(
                    deployedBytecodeInfo.bytecode,
                    bytesT,
                    state.memAllocator
                ) as BytesMemView;
                runtimeCodeView.encode(deployedBytecodeInfo.bytecode, state.memory);

                fields.push(["creationCode", memBytesT]);
                fields.push(["runtimeCode", memBytesT]);
                vals.push(["creationCode", creationCodeView]);
                vals.push(["runtimeCode", runtimeCodeView]);
            }

            if (contract.kind === sol.ContractKind.Interface) {
                fields.push(["interfaceId", rtt.bytes4]);
                vals.push(["interfaceId", interfaceId(contract)]);
            }

            const structT = new rtt.StructType(name, fields);

            return [new BuiltinStruct(name, structT, vals)];
        }

        rtt.nyi(`type(${solT.pp()})`);
    },
    false,
    false,
    false
);

const blockBaseFeeBuiltin = new BuiltinFunction(
    "basefee",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        interp.expect(state.block.header.baseFeePerGas !== undefined, `Missing basefee in block`);
        return [state.block.header.baseFeePerGas];
    },
    false,
    true,
    false
);

const blockBlobBaseFeeBuiltin = new BuiltinFunction(
    "blobbasefee",
    dummyFunT,
    (): Value[] => {
        rtt.nyi(`block.blobbasefee`);
    },
    false,
    true,
    false
);

const blockChainIdBuiltin = new BuiltinFunction(
    "chainid",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.block.common.chainId()];
    },
    false,
    true,
    false
);

const blockCoinbaseBuiltin = new BuiltinFunction(
    "coinbase",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.block.header.coinbase];
    },
    false,
    true,
    false
);

const blockGasLimitBuiltin = new BuiltinFunction(
    "gaslimit",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.block.header.gasLimit];
    },
    false,
    true,
    false
);

const blockNumberBuiltin = new BuiltinFunction(
    "number",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.block.header.number];
    },
    false,
    true,
    false
);

const blockTimestampBuiltin = new BuiltinFunction(
    "timestamp",
    dummyFunT,
    (interp: Interpreter, state: State): Value[] => {
        return [state.block.header.timestamp];
    },
    false,
    true,
    false
);

const blockBlockhashBuiltin = new BuiltinFunction(
    "blockhash",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(
            args.length === 1 && typeof args[0] === "bigint",
            `keccak256 expects a bytes array as argument`
        );
        const blockNum = args[0];

        if (
            blockNum > state.block.header.number ||
            blockNum < 0 ||
            state.block.header.number - blockNum > 255
        ) {
            return [new Uint8Array(32)];
        }

        if (state.block.header.number === blockNum) {
            return [state.block.hash()];
        }

        rtt.nyi(`blockhash(${blockNum})`);
    },
    false,
    false,
    false
);

const blockBuiltinStructDesc: BuiltinDescriptor = [
    "block",
    [
        blockBaseFeeBuiltin,
        blockBlobBaseFeeBuiltin,
        blockChainIdBuiltin,
        blockCoinbaseBuiltin,
        blockGasLimitBuiltin,
        blockNumberBuiltin,
        blockTimestampBuiltin,
        [[blockBlockhashBuiltin, "<0.5.0"]]
    ]
];

const ecrecoverBuiltin = new BuiltinFunction(
    "ecrecover",
    dummyFunT,
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        interp.expect(
            args.length === 4 &&
                args[0] instanceof Uint8Array &&
                typeof args[1] === "bigint" &&
                args[2] instanceof Uint8Array &&
                args[3] instanceof Uint8Array,
            `ecrecover expects (bytes32 hash, uint8 v, bytes32 r, bytes32 s)`
        );

        const [hash, v, r, s] = args;
        interp.expect(rtt.fits(v, rtt.uint8), `v must be a uint8`);

        const res = ecrecover(hash, v, r, s);

        return [createAddressFromPublicKey(res)];
    },
    false,
    false,
    false
);

const now = blockTimestampBuiltin.alias("now");
const blockHashBuiltin = blockBlockhashBuiltin.alias("blockhash");

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
        msgBuiltinStructDesc,
        typeBuiltin,
        blockBuiltinStructDesc,
        [[now, "<0.7.0"]],
        [[blockHashBuiltin, "<0.7.0"]],
        ecrecoverBuiltin
    ]
];

export const arrayBuiltinDecs: BuiltinDescriptor = [
    "<array builtins>",
    [
        [
            [pushPre06Builtin, "<0.6.0"],
            [push06Builtin, ">=0.6.0"]
        ],
        popBuiltin
    ]
];
