import { ImmMap, nyi, Storage } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { BaseScope, BuiltinsScope, ContractScope, LocalsScope } from "../../src/interp/scope";
import { WorldInterface, CallResult, State } from "../../src/interp/state";
import { Value } from "../../src/interp/value";
import { DefaultAllocator } from "sol-dbg/dist/debug/decoding/memory/allocator";
import { assertBuiltin, encodeConstants } from "../../src";

export const worldMock: WorldInterface = {
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

export function makeState(
    loc: sol.ASTNode,
    infer: sol.InferType,
    ...vals: Array<[string, Value]>
): State {
    const allocator = new DefaultAllocator();
    const unit = loc.getClosestParentByType(sol.SourceUnit) as sol.SourceUnit;
    const constantsMap = encodeConstants(unit, allocator)
    const res: State = {
        storage: ImmMap.fromEntries([]),
        memory: allocator.memory,
        allocator,
        extCallStack: [],
        intCallStack: [],
        version: "0.8.29",
        scope: undefined,
        localsStack: [],
        constantsMap
    };

    let nd: sol.ASTNode | undefined = loc;
    const scopeNodes: sol.ASTNode[] = [];

    while (nd !== undefined) {
        if (
            nd instanceof sol.ContractDefinition ||
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            scopeNodes.unshift(nd);
        }
        nd = nd.parent;
    }

    // Builtins
    let scope: BaseScope = new BuiltinsScope([["assert", assertBuiltin]], res, undefined);
    for (const nd of scopeNodes) {
        if (nd instanceof sol.ContractDefinition) {
            scope = new ContractScope(nd, infer, res, scope);
        } else if (
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            res.localsStack.push(new Map());
            scope = new LocalsScope(nd, res, scope);
        } else {
            nyi(`Scope nd ${nd.print()}`);
        }
    }

    res.scope = scope as BaseScope;

    for (const [name, val] of vals) {
        res.scope.set(name, val);
    }

    return res;
}
