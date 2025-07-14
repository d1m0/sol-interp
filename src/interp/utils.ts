import { makeMemoryView, nyi, PointerMemView, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { none, Value } from "./value";
import { SolMessage, State } from "./state";

export function makeZeroValue(t: sol.TypeNode, state: State): Value {
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
            // Reference types in memory with statically known size get auto-allocated
            const staticSize = PointerMemView.staticTypeAllocSize(t);
            if (staticSize !== undefined) {
                const address = state.allocator.alloc(staticSize);
                return makeMemoryView(t.to, address);
            }
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

// Hardcoded version good enough for debugging here.
const writer = new sol.ASTWriter(
    sol.DefaultASTWriterMapping,
    new sol.PrettyFormatter(4, 0),
    "0.8.29"
);

export function printNode(n: sol.ASTNode): string {
    return writer.write(n);
}

export const stringT = new sol.StringType();
export const bytesT = new sol.BytesType();
