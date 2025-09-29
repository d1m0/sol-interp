import { hexToBytes } from "@ethereumjs/util";
import {
    ArtifactInfo,
    BaseMemoryView,
    BytesMemView,
    DecodingFailure,
    Memory,
    PointerMemView,
    Value
} from "sol-dbg";
import { StringMemView } from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";

import { bytesT, stringT, topoSort, worldFailMock } from "./utils";
import { Interpreter } from "./interp";
import { ContractScope, GlobalScope } from "./scope";
import { makeNoContractState } from "./state";
import { isPrimitiveValue, NoneValue } from "./value";
import { ArtifactManager } from "./artifactManager";
import { ppValue } from "./pp";

type DepGraph = Map<sol.VariableDeclaration, Set<sol.VariableDeclaration>>;

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
function buildConstantDepGraph(
    units: Iterable<sol.SourceUnit>
): [sol.VariableDeclaration[], DepGraph] {
    const constNodes: sol.VariableDeclaration[] = [];
    const res: DepGraph = new Map();

    for (const unit of units) {
        unit.walk((nd) => {
            if (
                !(
                    nd instanceof sol.VariableDeclaration &&
                    nd.mutability === sol.Mutability.Constant
                )
            ) {
                return;
            }

            constNodes.push(nd);
            if (!res.has(nd)) {
                res.set(nd, new Set());
            }

            sol.assert(
                nd.vValue !== undefined,
                `Unexpected constant variable ${nd.name} with no initial value.`
            );

            nd.vValue.walk((initNd) => {
                if (!(initNd instanceof sol.Identifier || initNd instanceof sol.MemberAccess)) {
                    return;
                }

                const decl = initNd.vReferencedDeclaration;

                if (!(decl instanceof sol.VariableDeclaration)) {
                    return;
                }

                sol.assert(
                    decl.mutability === sol.Mutability.Constant,
                    `Unexpected non-constant variable ${decl.name} in init expression of constant var ${nd.name}`
                );
                let deps = res.get(decl);
                deps = deps === undefined ? new Set() : deps;
                deps.add(nd);
                res.set(decl, deps);
            });
        });
    }

    return [constNodes, res];
}

const NoneT = new rtt.TupleType([]);

class NoneView extends BaseMemoryView<NoneValue, rtt.TupleType> {
    encode(): void {
        throw new Error("Can't encode NoneView.");
    }
    decode(): DecodingFailure | NoneValue {
        throw new Error("Can't decode NoneView.");
    }
    constructor() {
        super(NoneT, 0n);
    }
}

/**
 * Given an `ArtifactManager`  evaluate all constant variables and complex literals in `SourceUnit`s managed by the `ArtifactManager` and
 * encode them into a single memory.
 *
 * This works by:
 *
 * 1. Find and encode the string/byte literals first
 * 2. Build a dependency graph among constant variables
 * 3. Sort constant state variables topologically over their dependencies
 * 4. Evaluate the constant state vars in topo order and encoding their values in the constant memory
 *
 * Note that constant literals are also placed in the topo order. They just don't have dependencies
 * @param unit
 * @returns
 */
export function gatherConstants(
    artifactManager: ArtifactManager,
    artifact: ArtifactInfo
): [Map<number, BaseMemoryView<Value, rtt.BaseRuntimeType>>, Memory] {
    const version = artifact.compilerVersion;
    const state = makeNoContractState();

    // First gather and encode the string constants
    for (const unit of artifact.units) {
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

            let view: StringMemView | BytesMemView;

            if (nd.kind === sol.LiteralKind.String || nd.kind === sol.LiteralKind.UnicodeString) {
                view = PointerMemView.allocMemFor(
                    nd.value,
                    stringT,
                    state.memAllocator
                ) as StringMemView;
                view.encode(nd.value, state.memory);
            } else {
                view = PointerMemView.allocMemFor(
                    nd.hexValue,
                    bytesT,
                    state.memAllocator
                ) as BytesMemView;
                const buf = hexToBytes(`0x${nd.hexValue}`);
                view.encode(buf, state.memory);
            }

            state.constantsMap.set(nd.id, view);
        });
    }

    const [constNodes, depGraph] = buildConstantDepGraph(artifact.units);
    const sortedNodes = topoSort(constNodes, depGraph);
    const interp = new Interpreter(worldFailMock, artifactManager, artifact, []);

    // Pre-init constantMap with NoneViews to appease Scope constructors
    for (const nd of sortedNodes) {
        state.constantsMap.set(nd.id, new NoneView());
    }

    // Next walk over the constant variable declarations in topoligcal order and evaluate them
    const infer = new sol.InferType(version);

    for (const nd of sortedNodes) {
        const typ = rtt.astToRuntimeType(
            infer.variableDeclarationToTypeNode(nd),
            infer,
            sol.DataLocation.Memory
        );

        state.account.contract = artifactManager.getContractInfo(nd);

        const scope = interp.makeStaticScope(nd, state);
        sol.assert(scope instanceof GlobalScope || scope instanceof ContractScope, ``);
        state.scope = scope;

        sol.assert(nd.vValue !== undefined, `Unexpected constant variable with no initializer`);
        const val = interp.eval(nd.vValue, state);

        let view: BaseMemoryView<Value, rtt.BaseRuntimeType>;

        if (val instanceof BaseMemoryView) {
            view = val;
        } else {
            sol.assert(isPrimitiveValue(val), `Unexpected constant value ${ppValue(val)}`);
            view = PointerMemView.allocMemFor(val, typ, state.memAllocator);
            view.encode(val, state.memory, state.memAllocator);
        }

        state.constantsMap.set(nd.id, view);
        scope.setConst(nd.name, view);
    }

    // @todo replace with state.memAllocator.baseOffset
    return [state.constantsMap, state.memory.slice(0x80)];
}
