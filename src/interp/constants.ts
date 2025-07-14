import { hexToBytes } from "@ethereumjs/util";
import { BaseMemoryView, BytesMemView, nyi, Value } from "sol-dbg";
import { DefaultAllocator, PointerMemView, StringMemView } from "sol-dbg";
import * as sol from "solc-typed-ast";

export function encodeConstants(
    unit: sol.SourceUnit,
    allocator: DefaultAllocator
): Map<number, BaseMemoryView<Value, sol.TypeNode>> {
    const res = new Map<number, BaseMemoryView<Value, sol.TypeNode>>();

    unit.walk((nd) => {
        if (
            !(
                nd instanceof sol.Literal &&
                (nd.kind === sol.LiteralKind.String ||
                    nd.kind === sol.LiteralKind.HexString ||
                    nd.kind === sol.LiteralKind.UnicodeString)
            )
        ) {
            return;
        }

        if (nd.kind === sol.LiteralKind.String || nd.kind === sol.LiteralKind.UnicodeString) {
            const loc = allocator.alloc(
                PointerMemView.allocSize(nd.value, sol.types.stringMemory.to)
            );
            const view = new StringMemView(sol.types.stringMemory.to, loc);
            view.encode(nd.value, allocator.memory);
            res.set(nd.id, view);
            return;
        }

        if (nd.kind === sol.LiteralKind.HexString) {
            const loc = allocator.alloc(
                PointerMemView.allocSize(nd.value, sol.types.bytesMemory.to)
            );
            const view = new BytesMemView(sol.types.stringMemory.to, loc);
            const buf = hexToBytes(`0x${nd.hexValue}`);
            view.encode(buf, allocator.memory);
            res.set(nd.id, view);
            return;
        }

        nyi(`Constants for string-ish literal constant ${nd.print()}`);
    });

    return res;
}
