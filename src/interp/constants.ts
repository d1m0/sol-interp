import { hexToBytes } from "@ethereumjs/util";
import { ArtifactManager, BaseMemoryView, BytesMemView, Memory, Value } from "sol-dbg";
import { DefaultAllocator, PointerMemView, StringMemView } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { topoSort, worldFailMock } from "./utils";
import { Interpreter } from "./interp";

type ConstNode = sol.VariableDeclaration | sol.Literal
type DepGraph = Map<ConstNode, Set<ConstNode>>;
/**
 * Given a set of `SourceUnit`s compute the dependency graph between constant
 * variables.  The graph is a map from a constant `VariableDeclaration`s id to
 * the ids of `VariableDeclaration`s that depend on it.
 * 
 * This function returns a list of `VariableDeclaration` and `Literals`, and a
 * `DepGraph` between the `VariableDeclaration`s. We include the `Literals` in
 * the list as they also need to be evaluated, but they don't have any
 * dependencies.
 */
function buildConstantDepGraph(units: sol.SourceUnit[]): [(sol.VariableDeclaration | sol.Literal)[], DepGraph] {
    const constNodes: (sol.VariableDeclaration | sol.Literal)[] = [];
    const res: DepGraph = new Map()

    for (const unit of units) {
        unit.walk((nd) => {
            if (
                (
                    nd instanceof sol.Literal &&
                    (nd.kind === sol.LiteralKind.String ||
                        nd.kind === sol.LiteralKind.HexString ||
                        nd.kind === sol.LiteralKind.UnicodeString)
                )
            ) {
                constNodes.push(nd);
                return;
            }

            if (!(nd instanceof sol.VariableDeclaration && nd.mutability === sol.Mutability.Constant)) {
                return;
            }

            constNodes.push(nd);
            sol.assert(nd.vValue !== undefined, `Unexpected constant variable ${nd.name} with no initial value.`);

            nd.vValue.walk((initNd) => {
                if (!(initNd instanceof sol.Identifier || initNd instanceof sol.MemberAccess)) {
                    return;
                }

                const decl = initNd.vReferencedDeclaration;

                if (!(decl instanceof sol.VariableDeclaration)) {
                    return;
                }

                let deps = res.get(decl);
                deps = deps === undefined ? new Set() : deps;
                deps.add(nd);
            })
        });
    }

    return [constNodes, res];
} 

/**
 * Given an `ArtifactManager`  evaluate all constant variables and complex literals in `SourceUnit`s managed by the `ArtifactManager` and
 * encode them into a single memory.
 * 
 * This works by:
 * 
 * 1. Building a dependency graph among constant variables
 * 2. Sorting constant state variables topologically over their dependencies
 * 3. Evaluating the constant state vars in topo order and encoding their values in the constant memory
 * 
 * Note that constant literals are also placed in the topo order. They just don't have dependencies
 * @param unit 
 * @returns 
 */
export function gatherConstants(
    artifactManager: ArtifactManager
): [Map<number, BaseMemoryView<Value, sol.TypeNode>>, Memory] {
    let allUnits: sol.SourceUnit[] = [];
    for (const artifact of artifactManager.artifacts()) {
        allUnits.push(...artifact.units)
    }

    const [constNodes, depGraph] = buildConstantDepGraph(allUnits);
    const sortedNodes = topoSort(constNodes, depGraph);

    const res = new Map<number, BaseMemoryView<Value, sol.TypeNode>>();
    const allocator = new DefaultAllocator();
    const interp = new Interpreter(worldFailMock, artifactManager)

    for (const node of sortedNodes) {
    }

    unit.walk((nd) => {
        // String literals
        if (
            (
                nd instanceof sol.Literal &&
                (nd.kind === sol.LiteralKind.String ||
                    nd.kind === sol.LiteralKind.HexString ||
                    nd.kind === sol.LiteralKind.UnicodeString)
            )
        ) {
            if (nd.kind === sol.LiteralKind.String || nd.kind === sol.LiteralKind.UnicodeString) {
                const loc = allocator.alloc(
                    PointerMemView.allocSize(nd.value, sol.types.stringMemory.to)
                );
                const view = new StringMemView(sol.types.stringMemory.to, loc);
                view.encode(nd.value, allocator.memory);
                res.set(nd.id, view);
                return;
            }

            const loc = allocator.alloc(
                PointerMemView.allocSize(nd.value, sol.types.bytesMemory.to)
            );
            const view = new BytesMemView(sol.types.bytesMemory.to, loc);
            const buf = hexToBytes(`0x${nd.hexValue}`);
            view.encode(buf, allocator.memory);
            res.set(nd.id, view);
            return;
        }
        // Constant vars (global and contract)
        if (nd instanceof sol.VariableDeclaration && nd.mutability === sol.Mutability.Constant) {
            this.expect(nd.vValue !== undefined, `Unexpected constant variable ${nd.name} with no initial value.`)
        }
    });

    return [res, allocator.memory];
}


export function encodeConstants(
    unit: sol.SourceUnit
): [Map<number, BaseMemoryView<Value, sol.TypeNode>>, Memory] {
    const res = new Map<number, BaseMemoryView<Value, sol.TypeNode>>();
    const allocator = new DefaultAllocator();

    unit.walk((nd) => {
        // String literals
        if (
            (
                nd instanceof sol.Literal &&
                (nd.kind === sol.LiteralKind.String ||
                    nd.kind === sol.LiteralKind.HexString ||
                    nd.kind === sol.LiteralKind.UnicodeString)
            )
        ) {
            if (nd.kind === sol.LiteralKind.String || nd.kind === sol.LiteralKind.UnicodeString) {
                const loc = allocator.alloc(
                    PointerMemView.allocSize(nd.value, sol.types.stringMemory.to)
                );
                const view = new StringMemView(sol.types.stringMemory.to, loc);
                view.encode(nd.value, allocator.memory);
                res.set(nd.id, view);
                return;
            }

            const loc = allocator.alloc(
                PointerMemView.allocSize(nd.value, sol.types.bytesMemory.to)
            );
            const view = new BytesMemView(sol.types.bytesMemory.to, loc);
            const buf = hexToBytes(`0x${nd.hexValue}`);
            view.encode(buf, allocator.memory);
            res.set(nd.id, view);
            return;
        }
        // Constant vars (global and contract)
        if (nd instanceof sol.VariableDeclaration && nd.mutability === sol.Mutability.Constant) {
            this.expect(nd.vValue !== undefined, `Unexpected constant variable ${nd.name} with no initial value.`)
        }
    });

    return [res, allocator.memory];
}
