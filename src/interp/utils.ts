import {
    bigIntToNum,
    ExpStructType,
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
    Storage
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import { none } from "./value";
import { CallResult, State, WorldInterface } from "./state";
import { BaseLocalView } from "./view";

/**
 * Marks that we reached a place we shouldn't have. Differs from nyi() in that this is definitely
 * not missing functionality.
 */
export function panic(msg: string): never {
    sol.assert(false, `Panic: ${msg}`);
}

export function makeZeroValue(t: sol.TypeNode, state: State): PrimitiveValue {
    if (t instanceof sol.IntType) {
        return 0n;
    }

    if (t instanceof sol.BoolType) {
        return false;
    }

    if (t instanceof sol.FixedBytesType) {
        return new Uint8Array(t.size);
    }

    if (t instanceof sol.AddressType) {
        return ZERO_ADDRESS;
    }

    if (t instanceof sol.PointerType) {
        if (t.location === sol.DataLocation.Memory) {
            let zeroValue: BaseValue;

            if (t.to instanceof sol.ArrayType) {
                const len = t.to.size !== undefined ? bigIntToNum(t.to.size) : 0;
                zeroValue = [];

                for (let i = 0; i < len; i++) {
                    zeroValue.push(makeZeroValue(t.to.elementT, state));
                }
            } else if (t.to instanceof sol.BytesType) {
                zeroValue = new Uint8Array();
            } else if (t.to instanceof sol.StringType) {
                zeroValue = "";
            } else if (t.to instanceof ExpStructType) {
                const fieldVals: Array<[string, PrimitiveValue]> = [];
                for (const [fieldName, fieldT] of t.to.fields) {
                    fieldVals.push([fieldName, makeZeroValue(fieldT, state)]);
                }
                zeroValue = new Struct(fieldVals);
            } else {
                nyi(`makeZeroValue of memory pointer type ${t.pp()}`);
            }

            const addr = state.memAllocator.alloc(PointerMemView.allocSize(zeroValue, t.to));
            const res = makeMemoryView(t.to, addr);
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

// @todo move to solc-typed-ast
export function isValueType(type: sol.TypeNode): boolean {
    return (
        type instanceof sol.IntType ||
        type instanceof sol.NumericLiteralType ||
        type instanceof sol.BoolType ||
        type instanceof sol.AddressType ||
        type instanceof sol.FixedBytesType ||
        (type instanceof sol.UserDefinedType &&
            (type.definition instanceof sol.EnumDefinition ||
                type.definition instanceof sol.ContractDefinition ||
                type.definition instanceof sol.UserDefinedValueTypeDefinition))
    );
}

//@todo move to sol-dbg
export function isStructView(
    v: any
): v is StructView<any, View<any, BaseValue, any, sol.TypeNode>> {
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

export const stringT = new sol.StringType();
export const bytesT = new sol.BytesType();

/**
 * Recursively change the location of all pointer in `type` to `loc`.
 * This duplicates code in `solc-typed-ast` because it needs to handle `ExpStructType`
 */
export function changeLocTo(type: sol.TypeNode, loc: sol.DataLocation): sol.TypeNode {
    if (type instanceof sol.PointerType) {
        return new sol.PointerType(changeLocTo(type.to, loc), loc);
    }

    if (type instanceof sol.ArrayType) {
        return new sol.ArrayType(changeLocTo(type.elementT, loc), type.size);
    }

    if (type instanceof sol.MappingType) {
        const genearlKeyT = changeLocTo(type.keyType, loc);
        const newValueT = changeLocTo(type.valueType, loc);

        return new sol.MappingType(genearlKeyT, newValueT);
    }

    if (type instanceof sol.TupleType) {
        return new sol.TupleType(
            type.elements.map((elT) => (elT === null ? null : changeLocTo(elT, loc)))
        );
    }

    if (type instanceof ExpStructType) {
        return new ExpStructType(
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
    create: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    call: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    staticcall: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    delegatecall: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    getStorage: function (): Storage {
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

export const bytes1 = new sol.FixedBytesType(1);
