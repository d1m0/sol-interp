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
    BaseStorageView
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import { none } from "./value";
import { SolMessage, State } from "./state";
import { BaseLocalView } from "./view";

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

            const addr = state.allocator.alloc(PointerMemView.allocSize(zeroValue, t.to));
            const res = makeMemoryView(t.to, addr);
            res.encode(zeroValue, state.memory, state.allocator);

            return res;
        }

        // In all other pointer case initialize with poison
        return none;
    }

    nyi(`makeZeroValue(${t.pp()})`);
}

function topExtFrame(state: State): SolMessage {
    sol.assert(state.extCallStack.length > 0, `No externall call frames`);
    return state.extCallStack[state.extCallStack.length - 1];
}

export function getMsg(state: State): Uint8Array {
    return topExtFrame(state).data;
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
