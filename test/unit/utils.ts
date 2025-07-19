import {
    ArtifactManager,
    BaseMemoryView,
    BaseStorageView,
    ImmMap,
    nyi,
    PartialSolcOutput,
    PrimitiveValue,
    Storage,
    Value
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { BaseScope, BuiltinsScope, ContractScope, LocalsScope } from "../../src/interp/scope";
import { WorldInterface, CallResult, State } from "../../src/interp/state";
import { DefaultAllocator } from "sol-dbg/dist/debug/decoding/memory/allocator";
import { assertBuiltin, encodeConstants } from "../../src";
import { Value as InterpValue } from "../../src/interp/value";
import { isValueType } from "../../src/interp/utils";
import { gt } from "semver";

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
    version: string,
    ...vals: Array<[string, Value]>
): State {
    const infer = new sol.InferType(version);
    const allocator = new DefaultAllocator();
    const unit = loc.getClosestParentByType(sol.SourceUnit) as sol.SourceUnit;
    const constantsMap = encodeConstants(unit, allocator);
    const res: State = {
        storage: ImmMap.fromEntries([]),
        memory: allocator.memory,
        allocator,
        extCallStack: [],
        intCallStack: [],
        version,
        scope: undefined,
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
    let scope: BaseScope = new BuiltinsScope(
        [["assert", assertBuiltin.type, assertBuiltin]],
        res,
        undefined
    );
    for (const nd of scopeNodes) {
        if (nd instanceof sol.ContractDefinition) {
            scope = new ContractScope(nd, infer, res, scope);
        } else if (
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            scope = new LocalsScope(nd, res, scope);
        } else {
            nyi(`Scope nd ${nd.print()}`);
        }
    }

    res.scope = scope as BaseScope;

    for (const [name, val] of vals) {
        const view = res.scope.lookupLocation(name);
        if (view instanceof BaseMemoryView) {
            view.encode(val, res.memory, res.allocator);
        } else if (view instanceof BaseStorageView) {
            res.storage = view.encode(val, res.storage);
        } else {
            nyi(`Encode ${val} in ${view}`);
        }
    }

    return res;
}

export function encodeMemArgs(args: Array<[string, Value]>, state: State): InterpValue[] {
    const res: InterpValue[] = [];

    for (const [name, val] of args) {
        const view = (state.scope as BaseScope).lookupLocation(name);
        sol.assert(view !== undefined, ``);
        if (isValueType(view.type)) {
            res.push(val as PrimitiveValue);
        } else {
            sol.assert(
                view instanceof BaseMemoryView,
                `Unexpected arg view: ${view.constructor.name}`
            );
            view.encode(val, state.memory, state.allocator);
            res.push(view);
        }
    }

    return res;
}

function getVersion(source: string): string {
    const version = source.match(/pragma solidity ([0-9.]*);/);
    sol.assert(version !== null, `No pragma found`);
    return version[1];
}

export interface SampleInfo {
    version: string;
    unit: sol.SourceUnit;
}

export type SampleMap = Map<string, SampleInfo>;

export async function loadSamples(names: string[]): Promise<[ArtifactManager, SampleMap]> {
    const res: SampleMap = new Map();
    const compileResults: Array<[PartialSolcOutput, string]> = [];
    for (const fileName of names) {
        const file = fse.readFileSync(`test/samples/${fileName}`, {
            encoding: "utf-8"
        });
        const version = getVersion(file);
        const compileResult = await sol.compileSourceString(
            fileName,
            file,
            version,
            undefined,
            undefined,
            gt(version, "0.8.0") ? { viaIR: true } : undefined
        );
        compileResults.push([compileResult.data, version]);
    }

    const artifactManager = new ArtifactManager(compileResults);
    for (let i = 0; i < names.length; i++) {
        const artifact = artifactManager.artifacts()[i];
        res.set(names[i], { version: artifact.compilerVersion, unit: artifact.units[0] });
    }

    return [artifactManager, res];
}
