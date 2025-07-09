import { nyi } from "sol-dbg";
import { DefaultAllocator } from "sol-dbg/dist/debug/decoding/memory/allocator";
import { PointerMemView, StringMemView } from "sol-dbg/dist/debug/decoding/memory/view";
import * as sol from "solc-typed-ast";

export function encodeConstants(unit: sol.SourceUnit, allocator: DefaultAllocator): Map<number, bigint> {
    const res = new Map<number, bigint>();

    unit.walk((nd) => {
        // @todo handle global string constants
        if (!(nd instanceof sol.Literal && (nd.kind === sol.LiteralKind.String || nd.kind === sol.LiteralKind.HexString || nd.kind === sol.LiteralKind.UnicodeString))) {
            return;
        }

        if (nd.kind === sol.LiteralKind.String) {
            const loc = allocator.alloc(PointerMemView.allocSize(nd.value, sol.types.stringMemory.to));
            const view = new StringMemView(sol.types.stringMemory.to, loc);
            view.encode(nd.value, allocator.memory)
            res.set(nd.id, loc);
            return;
        }

        nyi(`Constants for string-ish literal constant ${nd.print()}`)
    })

    return res;
}