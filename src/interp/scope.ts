import * as sol from "solc-typed-ast";
import { NotDefined } from "./exceptions";
import { LValue, Value } from "./value";
import { State } from "./state";
import { ExpStructType, getContractLayoutType } from "sol-dbg";
import { BaseStorageView, makeStorageView, StructStorageView } from "sol-dbg";
import { lt } from "semver";
import { ArrayLikeLocalView, PrimitiveLocalView, PointerLocalView } from "./view";

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
        protected readonly knownIds: Map<string, sol.TypeNode>,
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

    private static detectIds(
        node: LocalsScopeNodeType,
        version: string
    ): Map<string, sol.TypeNode> {
        const infer = new sol.InferType(version);
        const res = new Map<string, sol.TypeNode>();

        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            if (lt(version, "0.5.0")) {
                // In Solidity 0.4.x all state vars have block-wide scope
                for (const stmt of node.vStatements) {
                    if (stmt instanceof sol.VariableDeclarationStatement) {
                        for (const decl of stmt.vDeclarations) {
                            res.set(decl.name, infer.variableDeclarationToTypeNode(decl));
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
                    res.set(decl.name, infer.variableDeclarationToTypeNode(decl));
                }
            }
        } else if (node instanceof sol.FunctionDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.set(decl.name, infer.variableDeclarationToTypeNode(decl));
            }

            for (let i = 0; i < node.vReturnParameters.vParameters.length; i++) {
                const decl = node.vReturnParameters.vParameters[i];
                res.set(LocalsScope.returnName(decl, i), infer.variableDeclarationToTypeNode(decl));
            }
        } else if (node instanceof sol.ModifierDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.set(decl.name, infer.variableDeclarationToTypeNode(decl));
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
        const t = this.knownIds.get(name);
        if (t === undefined) {
            return undefined;
        }

        if (t instanceof sol.PointerType) {
            return new PointerLocalView(t, [this, name]);
        }

        if (t instanceof sol.FixedBytesType) {
            return new ArrayLikeLocalView(t, [this, name]);
        }

        return new PrimitiveLocalView(t, [this, name]);
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
        const defTypes = new Map<string, sol.TypeNode>(layoutType.fields);

        // On top of state vars also add function, enum, struct, user defined value type, event and error names.
        for (const base of contract.vLinearizedBaseContracts) {
            for (const fun of contract.vFunctions) {
                if (base == contract) {
                    defTypes.set(fun.name, infer.funDefToType(fun));
                } else {
                    if (fun.visibility !== sol.FunctionVisibility.Private) {
                        defTypes.set(fun.name, infer.funDefToType(fun));
                    }
                }
            }

            for (const enumDef of contract.vEnums) {
                defTypes.set(
                    enumDef.name,
                    new sol.TypeNameType(new sol.UserDefinedType(enumDef.name, enumDef))
                );
            }

            for (const structDef of contract.vStructs) {
                defTypes.set(
                    structDef.name,
                    new sol.TypeNameType(new sol.UserDefinedType(structDef.name, structDef))
                );
            }

            for (const event of contract.vEvents) {
                defTypes.set(event.name, infer.eventDefToType(event));
            }

            for (const error of contract.vErrors) {
                defTypes.set(error.name, infer.errDefToType(error));
            }

            for (const typeDef of contract.vUserDefinedValueTypes) {
                defTypes.set(
                    typeDef.name,
                    new sol.TypeNameType(new sol.UserDefinedType(typeDef.name, typeDef))
                );
            }
        }

        super(`<contract ${contract.name}>`, defTypes, state, _next);
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

    constructor(
        builtins: Array<[string, sol.TypeNode, Value]>,
        state: State,
        _next: BaseScope | undefined
    ) {
        super(`<builtins>`, new Map(builtins.map((x) => [x[0], x[1]])), state, _next);
        this.builtinsMap = new Map(builtins.map((x) => [x[0], x[2]]));
    }

    _lookup(name: string): Value | undefined {
        return this.builtinsMap.get(name);
    }

    _lookupLocation(): LValue | undefined {
        sol.assert(false, `Can't lookup a builtin's location`);
    }

    _set(): void {
        sol.assert(false, `Can't set a builtin after initialization`);
    }
}
