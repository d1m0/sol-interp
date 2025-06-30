import * as sol from "solc-typed-ast";
import { NotDefined } from "./exceptions";
import { Value } from "./value";
import { State } from "./state";
import { ExpStructType, getContractLayoutType } from "sol-dbg";
import { BaseStorageView, makeStorageView, StructStorageView } from "sol-dbg/dist/debug/decoding/storage/view";

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
        protected readonly _next: BaseScope | undefined) {
        console.error(`Making scope ${name} with ids [${[...knownIds].join(",")}]`)
    }

    abstract _lookup(name: string): Value | undefined
    abstract _set(name: string, val: Value): void

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


export type LocalsScopeNodeType = sol.UncheckedBlock | sol.Block | sol.FunctionDefinition | sol.ModifierDefinition
/**
 * Scope corresponding to the current top-level LocalsScope in State.
 * The relationship is fixed at construction, since we store a reference to the 
 * underlying map. So if we push more scopes 
 */
export class LocalsScope extends BaseScope {
    protected readonly defs: Map<string, Value>;

    private static detectIds(node: LocalsScopeNodeType): Set<string> {
        const res = new Set<string>();

        if (node instanceof sol.Block) {
            for (const stmt of node.vStatements) {
                if (stmt instanceof sol.VariableDeclarationStatement) {
                    for (const decl of stmt.vDeclarations) {
                        res.add(decl.name)
                    }
                }
            }
        } else if (node instanceof sol.FunctionDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.add(decl.name);
            }

            for (const decl of node.vReturnParameters.vParameters) {
                if (decl.name !== "") {
                    res.add(decl.name);
                }
            }
        } else if (node instanceof sol.ModifierDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.add(decl.name);
            }
        }

        return res;
    }

    constructor(
        protected readonly node: LocalsScopeNodeType,
        protected readonly state: State,
        protected readonly _next: BaseScope | undefined
    ) {
        let name: string
        if (node instanceof sol.Block) {
            name = `<locals for ${node.print(0)}>`;
        } else if (node instanceof sol.FunctionDefinition) {
            name = `<arg/rets for ${node.print(0)}>`;
        } else {
            name = `<arg for ${node.print(0)}>`;
        }

        super(name, LocalsScope.detectIds(node), state, _next);
        sol.assert(state.localsStack.length > 0, ``);
        this.defs = state.localsStack[state.localsStack.length - 1];
    }

    _lookup(name: string): Value | undefined {
        return this.defs.get(name);
    }

    _set(name: string, val: Value): void {
        this.defs.set(name, val);
    }
}

export class ContractScope extends BaseScope {
    private readonly layoutType: ExpStructType
    private readonly layout: StructStorageView;
    private fieldToView: Map<string, BaseStorageView<any, sol.TypeNode>>

    constructor(
        protected readonly contract: sol.ContractDefinition,
        infer: sol.InferType,
        protected readonly state: State,
        protected readonly _next: BaseScope | undefined
    ) {
        const [layoutType,] = getContractLayoutType(contract, infer)
        super(`<contract ${contract.name}>`, new Set<string>(layoutType.fields.map((v) => v[0])), state, _next);
        this.layoutType = layoutType;
        this.layout = makeStorageView(this.layoutType, [0n, 32]) as StructStorageView;
        this.fieldToView = new Map(this.layout.fieldViews);
    }

    _lookup(name: string): Value | undefined {
        const view = this.fieldToView.get(name) as BaseStorageView<any, sol.TypeNode>;
        if (view.type instanceof sol.PointerType) {
            return view;
        }

        return view.decode(this.state.storage)
    }

    _set(name: string, v: Value): void {
        const view = this.fieldToView.get(name) as BaseStorageView<any, sol.TypeNode>;

        sol.assert(!(view.type instanceof sol.PointerType), `Internal error: Cannot set pointer types in storage`);
        this.state.storage = view.encode(v, this.state.storage);
    }
}