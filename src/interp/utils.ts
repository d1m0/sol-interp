import {
    bigIntToNum,
    makeMemoryView,
    nyi,
    PointerMemView,
    PrimitiveValue,
    Struct,
    ZERO_ADDRESS,
    Value as BaseValue,
    StructView,
    StructMemView,
    StructCalldataView,
    StructStorageView,
    View,
    BaseMemoryView,
    BaseCalldataView,
    BaseStorageView,
    ContractInfo
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { ExternalCallDescription, none, Value } from "./value";
import { CallResult, State, WorldInterface } from "./state";
import { ArrayLikeLocalView, BaseLocalView, PointerLocalView, PrimitiveLocalView } from "./view";
import { AccountInfo } from "./chain";
import { BaseInterpType, DefType, TypeType } from "./types";
import { Address } from "@ethereumjs/util";
import { decodeLinkMap } from "sol-dbg/dist/debug/decoding/utils";

/**
 * Marks that we reached a place we shouldn't have. Differs from nyi() in that this is definitely
 * not missing functionality.
 */
export function panic(msg: string): never {
    sol.assert(false, `Panic: ${msg}`);
}

export function makeZeroValue(t: rtt.BaseRuntimeType, state: State): PrimitiveValue {
    if (t instanceof rtt.IntType) {
        return 0n;
    }

    if (t instanceof rtt.BoolType) {
        return false;
    }

    if (t instanceof rtt.FixedBytesType) {
        return new Uint8Array(t.numBytes);
    }

    if (t instanceof rtt.AddressType) {
        return ZERO_ADDRESS;
    }

    if (t instanceof rtt.PointerType) {
        // The only reazon we treat mem pointers differently is that uninitialized local mem variables are pre-allocated by default.
        if (t.location === sol.DataLocation.Memory) {
            let zeroValue: BaseValue;

            if (t.toType instanceof rtt.ArrayType) {
                const len = t.toType.size !== undefined ? bigIntToNum(t.toType.size) : 0;
                zeroValue = [];

                for (let i = 0; i < len; i++) {
                    zeroValue.push(makeZeroValue(t.toType.elementT, state));
                }
            } else if (t.toType instanceof rtt.BytesType) {
                zeroValue = new Uint8Array();
            } else if (t.toType instanceof rtt.StringType) {
                zeroValue = "";
            } else if (t.toType instanceof rtt.StructType) {
                const fieldVals: Array<[string, PrimitiveValue]> = [];
                for (const [fieldName, fieldT] of t.toType.fields) {
                    fieldVals.push([fieldName, makeZeroValue(fieldT, state)]);
                }
                zeroValue = new Struct(fieldVals);
            } else {
                nyi(`makeZeroValue of memory pointer type ${t.pp()}`);
            }

            const addr = state.memAllocator.alloc(PointerMemView.allocSize(zeroValue, t.toType));
            const res = makeMemoryView(t.toType, addr);
            res.encode(zeroValue, state.memory, state.memAllocator);

            return res;
        }

        // In all other pointer case initialize with poison
        return none;
    }

    nyi(`makeZeroValue(${t.pp()})`);
}

export function getMsg(state: State): Uint8Array {
    return state.msg.data;
}

export function getSig(state: State): Uint8Array {
    if (state.codeAccount !== undefined && state.msg.to.equals(ZERO_ADDRESS)) {
        return new Uint8Array();
    }

    // @todo when we send 3 bytes, is msg.data 0?
    if (state.msg.data.length < 4) {
        return new Uint8Array();
    }

    return state.msg.data.slice(0, 4);
}

export function getContractInfo(state: State): ContractInfo {
    return state.account.contract as ContractInfo;
}

export function getContract(state: State): sol.ContractDefinition {
    const info = getContractInfo(state);
    const res = info.ast;
    sol.assert(res !== undefined, `No AST for contract  ${info.contractName}`);
    return res;
}

/**
 * Get the `BytecodeInfo` and actual bytecode for the currently running context.
 * This handles delegate calls and distinguishing between bytecode and deployed bytecode
 */
export function getBytecodeInfo(state: State): [rtt.BytecodeInfo, Uint8Array] {
    if (state.codeAccount) {
        const info = state.codeAccount.contract;
        sol.assert(info !== undefined, ``);
        return [info.deployedBytecode, state.codeAccount.deployedBytecode];
    }

    const info = state.account.contract;
    sol.assert(info !== undefined, ``);

    return state.msg.to.equals(rtt.ZERO_ADDRESS)
        ? [info.bytecode, state.account.bytecode]
        : [info.deployedBytecode, state.account.deployedBytecode];
}

/**
 * Given a library `ContractDefinition` and the current `State` get the linked address
 * for that library.
 */
export function getLibraryLinkedAddress(lib: sol.ContractDefinition, state: State): Address {
    sol.assert(lib.kind === sol.ContractKind.Library, ``);
    const libId = `${lib.vScope.sourceEntryKey}:${lib.name}`;
    const [bytecodeInfo, bytecode] = getBytecodeInfo(state);
    const ranges = bytecodeInfo.linkReferences.get(libId);

    sol.assert(ranges !== undefined && ranges.length > 0, `Ranges missing for ${libId}: ${ranges}`);

    const linkMap = decodeLinkMap(bytecodeInfo, bytecode);
    const addr = linkMap.get(libId);

    sol.assert(addr !== undefined, `No linked address found for ${libId}`);
    return addr;
}

/**
 * Returns the contract info for the *CODE* of the currently executing context. Handles delegate calls
 * @param state
 * @returns
 */
export function getCodeContractInfo(state: State): ContractInfo {
    const info =
        state.codeAccount !== undefined ? state.codeAccount.contract : state.account.contract;
    sol.assert(info !== undefined, `No contract in current state`);
    return info;
}

/**
 * Returns the address of the currently executing context. Handles delegate calls
 * @param state
 * @returns
 */
export function getCodeContract(state: State): sol.ContractDefinition {
    const info =
        state.codeAccount !== undefined ? state.codeAccount.contract : state.account.contract;
    sol.assert(info !== undefined, `No contract in current state`);
    const res = info.ast;
    sol.assert(res !== undefined, `No AST for contract  ${info.contractName}`);
    return res;
}

/**
 * Returns the storage of the currently executing context. Handles delegate calls
 * @param state
 * @returns
 */
export function getStateStorage(state: State): rtt.Storage {
    return state.account.storage;
}

/**
 * Set the storage of the state's current context
 * @param state
 * @returns
 */
export function setStateStorage(state: State, newStorage: rtt.Storage): rtt.Storage {
    return (state.account.storage = newStorage);
}

/**
 * Returns the address of the currently executing contract
 * @param state
 * @returns
 */
export function getThis(state: State): Address {
    return state.account.address;
}

/**
 * Returns msg.sender
 * @param state
 * @returns
 */
export function getMsgSender(state: State): Address {
    return state.msg.from;
}

export function decodeView(lv: View, state: State): BaseValue {
    if (lv instanceof BaseStorageView) {
        return lv.decode(getStateStorage(state));
    } else if (lv instanceof BaseMemoryView) {
        return lv.decode(state.memory);
    } else if (lv instanceof BaseCalldataView) {
        return lv.decode(getMsg(state));
    } else if (lv instanceof PrimitiveLocalView) {
        return lv.decode();
    }

    nyi(`decode(${lv})`);
}

export function deref<T extends rtt.StateArea>(
    v: rtt.PointerView<T, View>,
    state: State
): View<any, BaseValue, any, rtt.BaseRuntimeType> {
    let res: View<any, BaseValue, any, rtt.BaseRuntimeType> | rtt.DecodingFailure;

    if (v instanceof rtt.PointerMemView) {
        res = v.toView(state.memory);
    } else if (v instanceof rtt.PointerCalldataView) {
        res = v.toView(getMsg(state));
    } else if (v instanceof rtt.PointerStorageView) {
        res = v.toView();
    } else if (v instanceof PointerLocalView) {
        res = v.toView();
    } else {
        nyi(`Pointer view ${v.constructor.name}`);
    }

    sol.assert(!(res instanceof rtt.DecodingFailure), `Couldn't deref pointer view ${v.pp()}`);
    return res;
}

export function length<T extends rtt.StateArea>(
    v: rtt.ArrayLikeView<T, View>,
    state: State
): bigint {
    let res: bigint | rtt.DecodingFailure;

    if (rtt.isArrayLikeStorageView(v)) {
        res = v.size(getStateStorage(state));
    } else if (rtt.isArrayLikeMemView(v)) {
        res = v.size(state.memory);
    } else if (rtt.isArrayLikeCalldataView(v)) {
        res = v.size(getMsg(state));
    } else if (v instanceof ArrayLikeLocalView) {
        res = v.size();
    } else {
        nyi(`getSize(${v})`);
    }

    sol.assert(!(res instanceof rtt.DecodingFailure), `Couldn't deref pointer view ${v.pp()}`);
    return res;
}

export function indexView<T extends rtt.StateArea>(
    v: rtt.IndexableView<BaseValue, T, View>,
    key: BaseValue,
    state: State
): View<any, BaseValue, any, rtt.BaseRuntimeType> {
    let res: View<any, BaseValue, any, rtt.BaseRuntimeType> | rtt.DecodingFailure;

    if (v instanceof rtt.MapStorageView) {
        res = (v as rtt.MapStorageView).indexView(key);
    } else {
        sol.assert(typeof key === "bigint", ``);

        if (v instanceof rtt.ArrayMemView || v instanceof rtt.BytesMemView) {
            res = v.indexView(key, state.memory);
        } else if (v instanceof rtt.ArrayCalldataView || v instanceof rtt.BytesCalldataView) {
            res = v.indexView(key, getMsg(state));
        } else if (v instanceof rtt.ArrayStorageView || v instanceof rtt.BytesStorageView) {
            res = v.indexView(key, getStateStorage(state));
        } else {
            nyi(`Pointer view ${v.constructor.name}`);
        }
    }

    sol.assert(!(res instanceof rtt.DecodingFailure), `Couldn't deref pointer view ${v.pp()}`);
    return res;
}

// @todo move to solc-typed-ast
// @todo dimo: Is it sufficient here to say !(type instancesof sol.PointerType) ?
export function isValueType(type: rtt.BaseRuntimeType): boolean {
    return (
        type instanceof rtt.IntType ||
        type instanceof rtt.BoolType ||
        type instanceof rtt.AddressType ||
        type instanceof rtt.FixedBytesType
    );
}

//@todo move to sol-dbg
export function isStructView(
    v: any
): v is StructView<any, View<any, BaseValue, any, rtt.BaseRuntimeType>> {
    return (
        v instanceof StructMemView ||
        v instanceof StructCalldataView ||
        v instanceof StructStorageView
    );
}

// Hardcoded version good enough for debugging here.
const writer = new sol.ASTWriter(
    sol.DefaultASTWriterMapping,
    new sol.PrettyFormatter(4, 0),
    "0.8.29"
);

export function printNode(n: sol.ASTNode): string {
    return writer.write(n);
}

export function getViewLocation(v: View): sol.DataLocation | "local" {
    if (v instanceof BaseMemoryView) {
        return sol.DataLocation.Memory;
    }

    if (v instanceof BaseCalldataView) {
        return sol.DataLocation.CallData;
    }

    if (v instanceof BaseStorageView) {
        return sol.DataLocation.Storage;
    }

    if (v instanceof BaseLocalView) {
        return "local";
    }

    nyi(`View type ${v.pp()}`);
}

/**
 * Returns true IFF a value of `rType` is directly assignable to an LValue of `lvType`.
 * @param lvType
 * @param rType
 */
export function isDirectlyAssignable(
    lvType: rtt.BaseRuntimeType,
    rType: rtt.BaseRuntimeType
): boolean {
    if (lvType instanceof rtt.PointerType) {
        // We have more permissive casting for assignments to storage arrays
        if (
            lvType.toType instanceof rtt.ArrayType &&
            lvType.location === sol.DataLocation.Storage &&
            rType instanceof rtt.ArrayType
        ) {
            return (
                (lvType.toType.size === undefined || lvType.toType.size === rType.size) && // Sizes match
                isDirectlyAssignable(lvType.toType.elementT, rType.elementT)
            );
        }

        if (
            lvType.toType instanceof rtt.ArrayType &&
            lvType.location === sol.DataLocation.Storage &&
            rType instanceof rtt.PointerType &&
            rType.toType instanceof rtt.ArrayType
        ) {
            return (
                (lvType.toType.size === undefined || lvType.toType.size === rType.toType.size) && // Sizes match
                isDirectlyAssignable(lvType.toType.elementT, rType.toType.elementT)
            );
        }

        return typesEqualModuloLocation(lvType.toType, rType);
    }

    // Primitive LValue type
    if (lvType instanceof rtt.IntType && rType instanceof rtt.IntType) {
        return lvType.signed === rType.signed && lvType.numBits >= rType.numBits;
    }

    return lvType.pp() == rType.pp();
}

/**
 * Returns true IFF `t1` and `t2` are structuraly the same, except for any data locations.
 * @param t1
 * @param t2
 */
export function typesEqualModuloLocation(
    t1: rtt.BaseRuntimeType,
    t2: rtt.BaseRuntimeType
): boolean {
    return (
        changeLocTo(t1, sol.DataLocation.Memory).pp() ==
        changeLocTo(t2, sol.DataLocation.Memory).pp()
    );
}

/**
 * Recursively change the location of all pointer in `type` to `loc`.
 * This duplicates code in `solc-typed-ast` because it needs to handle `StructType`
 */
export function changeLocTo(type: rtt.BaseRuntimeType, loc: sol.DataLocation): rtt.BaseRuntimeType {
    if (type instanceof rtt.PointerType) {
        return new rtt.PointerType(changeLocTo(type.toType, loc), loc);
    }

    if (type instanceof rtt.ArrayType) {
        return new rtt.ArrayType(changeLocTo(type.elementT, loc), type.size);
    }

    if (type instanceof rtt.MappingType) {
        const genearlKeyT = changeLocTo(type.keyType, loc);
        const newValueT = changeLocTo(type.valueType, loc);

        return new rtt.MappingType(genearlKeyT, newValueT);
    }

    if (type instanceof rtt.TupleType) {
        return new rtt.TupleType(type.elementTypes.map((elT) => changeLocTo(elT, loc)));
    }

    if (type instanceof rtt.StructType) {
        return new rtt.StructType(
            type.name,
            type.fields.map(([name, type]) => [name, changeLocTo(type, loc)])
        );
    }

    return type;
}

/**
 * Given a list of T's `things` and a partial ordering between them `order` return
 * a topologically sorted version of `things`. For any pair `[a,b]` in `order` we assume
 * that `a` has to come before `b`.
 *
 * Shamelessly stolen from
 */
export function topoSort<T extends sol.PPIsh>(things: T[], successors: Map<T, Set<T>>): T[] {
    if (things.length === 0) {
        return things;
    }

    const nPreds = new Map<T, number>();

    // Initialize datastructures
    for (const thing of things) {
        nPreds.set(thing, 0);
    }

    // Populate nPreds and successors according to the partial order `order`
    for (const [, succs] of successors) {
        for (const succ of succs) {
            nPreds.set(succ, (nPreds.get(succ) as number) + 1);
        }
    }

    // Compute the initial roots and add them to res
    const res: T[] = [];

    for (const thing of things) {
        if ((nPreds.get(thing) as number) === 0) {
            res.push(thing);
        }
    }

    sol.assert(res.length > 0, "Dep graph {0} is not a proper dep graph");

    let i = 0;

    // Add nodes to the order until all are added
    while (res.length < things.length) {
        const curLength = res.length;

        // For every newly added node N from last iteration ([i...curLength-1]),
        // and for all successors S of N, reduce nPreds[S]. If nPreds[S] == 0 add to res.
        for (; i < curLength; i++) {
            for (const successor of successors.get(res[i]) as Set<T>) {
                const newCount = (nPreds.get(successor) as number) - 1;

                nPreds.set(successor, newCount);

                if (newCount === 0) {
                    res.push(successor);
                }
            }
        }

        sol.assert(
            res.length > curLength,
            "Dep graph is not a valid partial order. Topo sort stalled at {1} out of {2}",
            res.length,
            things.length
        );
    }

    return res;
}

export const worldFailMock: WorldInterface = {
    create: function (): CallResult {
        throw new Error("Function not implemented.");
    },
    call: function (): CallResult {
        throw new Error("Function not implemented.");
    },
    staticcall: function (): CallResult {
        throw new Error("Function not implemented.");
    },
    delegatecall: function (): CallResult {
        throw new Error("Function not implemented.");
    },
    getAccount: function (): AccountInfo | undefined {
        throw new Error("Function not implemented.");
    },
    setAccount: function (): void {
        throw new Error("Function not implemented.");
    },
    updateAccount: function (): void {
        throw new Error("Function not implemented.");
    }
};

/**
 * Return the modifier invocations that correspond to actual modifiers (and not base constructor calls)
 */
export function getModifiers(f: sol.FunctionDefinition): sol.ModifierInvocation[] {
    return f.vModifiers.filter((m) => m.vModifier instanceof sol.ModifierDefinition);
}

/**
 * Return true iff f is a contract method (i.e. its not a global or a library function)
 * @param f
 */
export function isMethod(f: sol.FunctionDefinition | sol.VariableDeclaration): boolean {
    return (
        f instanceof sol.FunctionDefinition &&
        f.vScope instanceof sol.ContractDefinition &&
        f.vScope.kind === sol.ContractKind.Contract
    );
}

export function solcValueToValue(solV: sol.Value): Value {
    if (typeof solV === "bigint" || typeof solV === "boolean") {
        return solV;
    }

    if (solV instanceof Buffer) {
        return new Uint8Array(solV);
    }

    sol.assert(false, `Cannot convert solc value ${solV}`);
}

/**
 * Helper to cast the bigint `val` to the `IntType` `type`.
 */
export function clampIntToType(val: bigint, type: rtt.IntType): bigint {
    const min = type.min();
    const max = type.max();

    const size = max - min + 1n;

    return val < min ? ((val - max) % size) + max : ((val - min) % size) + min;
}

export function removeLiteralTypes(
    t: sol.TypeNode,
    e: sol.Expression,
    infer: sol.InferType
): sol.TypeNode {
    if (t instanceof sol.IntLiteralType) {
        const v = sol.evalConstantExpr(e, infer);
        sol.assert(typeof v === "bigint", ``);
        const smallestT = sol.smallestFittingType(v);
        sol.assert(smallestT !== undefined, ``);
        return smallestT;
    }

    if (t instanceof sol.StringLiteralType) {
        return sol.types.stringMemory;
    }

    // Tuples
    if (t instanceof sol.TupleType && e instanceof sol.TupleExpression) {
        const elTs: Array<sol.TypeNode | null> = [];

        for (let i = 0; i < t.elements.length; i++) {
            let elT = t.elements[i];

            if (elT instanceof sol.IntLiteralType) {
                elT = removeLiteralTypes(elT, e.vOriginalComponents[i] as sol.Expression, infer);
            }

            elTs.push(elT);
        }

        return new sol.TupleType(elTs);
    }

    return t;
}

export function getGetterArgAndReturnTs(
    getter: sol.VariableDeclaration,
    infer: sol.InferType
): [BaseInterpType[], BaseInterpType[]] {
    const [solArgTs, solRetT] = infer.getterArgsAndReturn(getter);
    const argTs: BaseInterpType[] = solArgTs.map((solT) =>
        rtt.astToRuntimeType(solT, infer, sol.DataLocation.CallData)
    );
    const retT = rtt.astToRuntimeType(solRetT, infer, sol.DataLocation.CallData);
    return [argTs, retT instanceof rtt.TupleType ? retT.elementTypes : [retT]];
}

/**
 * Return the value, gas, salt of a value of its an ExternalCallDescription and undefineds otherwise
 */
export function getExternalCallComponents(
    arg: Value
): [bigint | undefined, bigint | undefined, Uint8Array | undefined] {
    if (arg instanceof ExternalCallDescription) {
        return [arg.value, arg.gas, arg.salt];
    }

    return [undefined, undefined, undefined];
}

export const int256 = new rtt.IntType(256, true);
export const bytes24 = new rtt.FixedBytesType(24);
export const bytes32 = new rtt.FixedBytesType(32);
export const stringT = new rtt.StringType();
export const addressT = new rtt.AddressType();
export const memStringT = new rtt.PointerType(stringT, sol.DataLocation.Memory);
export const bytesT = new rtt.BytesType();
export const memBytesT = new rtt.PointerType(bytesT, sol.DataLocation.Memory);
export const bytes1 = new rtt.FixedBytesType(1);
export const defT = new DefType();
export const typeT = new TypeType();

/**
 * Return true IFF baseContract is a base (or the same contract) of childContract
 */
export function isBaseOf(
    baseContract: sol.ContractDefinition,
    childContract: sol.ContractDefinition
): boolean {
    for (const base of childContract.vLinearizedBaseContracts) {
        if (base === baseContract) {
            return true;
        }
    }

    return false;
}
