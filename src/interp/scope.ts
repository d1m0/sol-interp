import * as sol from "solc-typed-ast";
import { NotDefined } from "./exceptions";
import { LValue, Value } from "./value";
import { State } from "./state";
import { ExpStructType, getContractLayoutType } from "sol-dbg";
import {
    BaseStorageView,
    makeStorageView,
    StructStorageView
} from "sol-dbg/dist/debug/decoding/storage/view";
import { lt } from "semver";

/**
 * Identifier scopes.  Note that scopes themselves dont store values - only the
 * state does. They only know where identifiers live in the state.
 *
 * At any point in the interpretation we have the following scope stack:
 *
 * <block scope>
 * ...
 * <block scope>
 * <function arg scope> | <modifier arg scope>
 * <state vars scope>
 * <globals scope>
 * <builtins scope>
 *
 * Note that the block scope is the only one that can have multiples in the stack. All other scope types appear at most ones.
 * (i.e. this is not a call stack!).
 *
 * Since most builtin identifiers (except for this and super) can be shadowed, having them in the
 * builtins scope helps us faithfully model the langauge semantics.
 *
 */
export abstract class BaseScope {
    constructor(
        public readonly name: string,
        protected readonly knownIds: Set<string>,
        protected readonly state: State,
        public readonly _next: BaseScope | undefined
    ) {}

    abstract _lookup(name: string): Value | undefined;
    abstract _lookupLocation(name: string): LValue | undefined;
    abstract _set(name: string, val: Value): void;

    lookup(name: string): Value {
        let v;

        if (this.knownIds.has(name)) {
            v = this._lookup(name);
        } else {
            v = this._next ? this._next.lookup(name) : undefined;
        }

        if (v === undefined) {
            throw new NotDefined(name);
        }

        return v;
    }

    lookupLocation(name: string): LValue {
        let v;

        if (this.knownIds.has(name)) {
            v = this._lookupLocation(name);
        } else {
            v = this._next ? this._next.lookupLocation(name) : undefined;
        }

        if (v === undefined) {
            throw new NotDefined(name);
        }

        return v;
    }

    set(name: string, val: Value): void {
        if (this.knownIds.has(name)) {
            this._set(name, val);
            return;
        }

        if (this._next === undefined) {
            throw new NotDefined(name);
        }

        this._next.set(name, val);
    }
}

export type LocalsScopeNodeType =
    | sol.UncheckedBlock
    | sol.Block
    | sol.UncheckedBlock
    // In Solidity >0.5.0 each VariableDeclarationStatement is its own scope from now, till the end of the defining block
    | sol.VariableDeclarationStatement
    | sol.FunctionDefinition
    | sol.ModifierDefinition;

/**
 * Scope corresponding to the current top-level LocalsScope in State.
 * The relationship is fixed at construction, since we store a reference to the
 * underlying map. So if we push more scopes
 */
export class LocalsScope extends BaseScope {
    protected readonly defs: Map<string, Value>;

    public static returnName(decl: sol.VariableDeclaration, idx: number): string {
        return decl.name === "" ? `<ret_${idx}>` : decl.name;
    }

    private static detectIds(node: LocalsScopeNodeType, version: string): Set<string> {
        const res = new Set<string>();

        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            if (lt(version, "0.5.0")) {
                // In Solidity 0.4.x all state vars have block-wide scope
                for (const stmt of node.vStatements) {
                    if (stmt instanceof sol.VariableDeclarationStatement) {
                        for (const decl of stmt.vDeclarations) {
                            res.add(decl.name);
                        }
                    }
                }
            } else {
                // Nothing to do
            }
        } else if (node instanceof sol.VariableDeclarationStatement) {
            if (lt(version, "0.5.0")) {
                // Nothing to do
            } else {
                // In solidity >= 0.5.0 each local variable has a scope starting at its declaration
                for (const decl of node.vDeclarations) {
                    res.add(decl.name);
                }
            }
        } else if (node instanceof sol.FunctionDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.add(decl.name);
            }

            for (let i = 0; i < node.vReturnParameters.vParameters.length; i++) {
                res.add(LocalsScope.returnName(node.vReturnParameters.vParameters[i], i));
            }
        } else if (node instanceof sol.ModifierDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.add(decl.name);
            }
        }

        return res;
    }

    constructor(
        public readonly node: LocalsScopeNodeType,
        state: State,
        _next: BaseScope | undefined
    ) {
        let name: string;
        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            name = `<block ${node.print(0)}>`;
        } else if (node instanceof sol.VariableDeclaration) {
            name = `<local ${node.name}>`;
        } else if (node instanceof sol.FunctionDefinition) {
            name = `<arg/rets for ${node.print(0)}>`;
        } else {
            name = `<arg for ${node.print(0)}>`;
        }

        super(name, LocalsScope.detectIds(node, state.version), state, _next);

        sol.assert(state.localsStack.length > 0, ``);
        this.defs = state.localsStack[state.localsStack.length - 1];
    }

    _lookup(name: string): Value | undefined {
        return this.defs.get(name);
    }

    _lookupLocation(name: string): LValue | undefined {
        return this.defs.has(name) ? { scope: this, name } : undefined;
    }

    _set(name: string, val: Value): void {
        this.defs.set(name, val);
    }
}

export class ContractScope extends BaseScope {
    private readonly layoutType: ExpStructType;
    private readonly layout: StructStorageView;
    private fieldToView: Map<string, BaseStorageView<any, sol.TypeNode>>;

    constructor(
        protected readonly contract: sol.ContractDefinition,
        infer: sol.InferType,
        state: State,
        _next: BaseScope | undefined
    ) {
        const [layoutType] = getContractLayoutType(contract, infer);
        const defNames = new Set<string>(layoutType.fields.map((v) => v[0]));

        // On top of state vars also add function, enum, struct, user defined value type, event and error names.
        for (const base of contract.vLinearizedBaseContracts) {
            for (const fun of contract.vFunctions) {
                if (base == contract) {
                    defNames.add(fun.name);
                } else {
                    if (fun.visibility !== sol.FunctionVisibility.Private) {
                        defNames.add(fun.name);
                    }
                }
            }

            for (const enumDef of contract.vEnums) {
                defNames.add(enumDef.name);
            }

            for (const structDef of contract.vStructs) {
                defNames.add(structDef.name);
            }

            for (const event of contract.vEvents) {
                defNames.add(event.name);
            }

            for (const error of contract.vErrors) {
                defNames.add(error.name);
            }

            for (const typeDef of contract.vUserDefinedValueTypes) {
                defNames.add(typeDef.name);
            }
        }

        super(`<contract ${contract.name}>`, defNames, state, _next);
        this.layoutType = layoutType;
        this.layout = makeStorageView(this.layoutType, [0n, 32]) as StructStorageView;
        this.fieldToView = new Map(this.layout.fieldViews);
    }

    _lookup(name: string): Value | undefined {
        const view = this.fieldToView.get(name) as BaseStorageView<any, sol.TypeNode>;
        if (view.type instanceof sol.PointerType) {
            return view;
        }

        return view.decode(this.state.storage);
    }

    _lookupLocation(name: string): LValue | undefined {
        return this.fieldToView.get(name) as any;
    }

    _set(name: string, v: Value): void {
        const view = this.fieldToView.get(name) as BaseStorageView<any, sol.TypeNode>;

        sol.assert(
            !(view.type instanceof sol.PointerType),
            `Internal error: Cannot set pointer types in storage`
        );
        this.state.storage = view.encode(v, this.state.storage);
    }
}

export class BuiltinsScope extends BaseScope {
    builtinsMap: Map<string, Value>;

    constructor(builtins: Array<[string, Value]>, state: State, _next: BaseScope | undefined) {
        super(`<builtins>`, new Set(builtins.map(([name]) => name)), state, _next);
        this.builtinsMap = new Map(builtins);
    }

    _lookup(name: string): Value | undefined {
        return this.builtinsMap.get(name);
    }

    _lookupLocation(name: string): LValue | undefined {
        sol.assert(false, `Can't lookup a builtin's location`);
    }

    _set(): void {
        sol.assert(false, `Can't set a builtin after initialization`);
    }
}
