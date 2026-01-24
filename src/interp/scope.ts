import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { Value } from "./value";
import { State } from "./state";
import {
    BaseMemoryView,
    getContractLayoutType,
    PointerStorageView,
    View,
    Value as BaseValue,
    DecodingFailure,
    PrimitiveValue
} from "sol-dbg";
import { BaseStorageView, makeStorageView, StructStorageView } from "sol-dbg";
import { lt } from "semver";
import { FixedBytesLocalView, PrimitiveLocalView, PointerLocalView, BaseLocalView } from "./view";
import { gatherStateVars, getStateStorage, isValueType, panic, setStateStorage } from "./utils";
import { typeIdToRuntimeType } from "./types";

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
        protected readonly knownIds: Map<sol.VariableDeclaration, rtt.BaseRuntimeType>,
        protected readonly state: State,
        public readonly _next: BaseScope | undefined
    ) {}

    abstract _lookup(decl: sol.VariableDeclaration): Value | undefined;
    abstract _lookupLocation(decl: sol.VariableDeclaration): View | undefined;
    abstract _set(decl: sol.VariableDeclaration, val: Value): void;

    lookup(decl: sol.VariableDeclaration): Value | undefined {
        let v;

        if (this.knownIds.has(decl)) {
            v = this._lookup(decl);
        } else {
            v = this._next ? this._next.lookup(decl) : undefined;
        }

        return v;
    }

    lookupLocation(decl: sol.VariableDeclaration): View | undefined {
        let v;

        if (this.knownIds.has(decl)) {
            v = this._lookupLocation(decl);
        } else {
            v = this._next ? this._next.lookupLocation(decl) : undefined;
        }

        return v;
    }

    set(decl: sol.VariableDeclaration, val: Value): void {
        if (this.knownIds.has(decl)) {
            this._set(decl, val);
            return;
        }

        if (this._next === undefined) {
            return;
        }

        this._next.set(decl, val);
    }

    findDecl(name: string): sol.VariableDeclaration | undefined {
        for (const decl of this.knownIds.keys()) {
            if (decl.name === name) {
                return decl;
            }
        }

        return this._next === undefined ? undefined : this._next.findDecl(name);
    }
}

/**
 * Base class for a Scope that stores data locally. Could be either Solidity stack locals (function args, returns, locals) or
 * interpreter specific temporaries.
 */
abstract class BaseLocalsScope extends BaseScope {
    protected defs = new Map<sol.VariableDeclaration, Value>();
    protected readonly viewsMap: Map<
        sol.VariableDeclaration,
        BaseLocalView<PrimitiveValue, rtt.BaseRuntimeType>
    >;

    constructor(
        name: string,
        defTypesMap: Map<sol.VariableDeclaration, rtt.BaseRuntimeType>,
        state: State,
        _next: BaseScope | undefined
    ) {
        super(name, defTypesMap, state, _next);

        const declAndView: Array<
            [sol.VariableDeclaration, BaseLocalView<PrimitiveValue, rtt.BaseRuntimeType>]
        > = [...defTypesMap.entries()].map(([decl, type]) => [
            decl,
            this.makeLocalView(decl, type)
        ]);
        this.viewsMap = new Map(declAndView);
    }

    _lookup(decl: sol.VariableDeclaration): Value | undefined {
        return this.defs.get(decl);
    }

    private makeLocalView(
        decl: sol.VariableDeclaration,
        t: rtt.BaseRuntimeType
    ): BaseLocalView<PrimitiveValue, rtt.BaseRuntimeType> {
        if (t instanceof rtt.PointerType) {
            return new PointerLocalView(t, [this, decl]);
        }

        if (t instanceof rtt.MappingType) {
            return new PointerLocalView(new rtt.PointerType(t, sol.DataLocation.Storage), [
                this,
                decl
            ]);
        }

        if (t instanceof rtt.FixedBytesType) {
            return new FixedBytesLocalView(t, [this, decl]);
        }

        return new PrimitiveLocalView(t, [this, decl]);
    }

    _lookupLocation(decl: sol.VariableDeclaration): View | undefined {
        return this.viewsMap.get(decl);
    }

    _set(decl: sol.VariableDeclaration, val: Value): void {
        this.defs.set(decl, val);
    }
}

type LocalsScopeNodeType =
    | sol.UncheckedBlock
    | sol.Block
    | sol.UncheckedBlock
    // In Solidity >0.5.0 each VariableDeclarationStatement is its own scope from now, till the end of the defining block
    | sol.VariableDeclarationStatement
    | sol.FunctionDefinition
    | sol.ModifierDefinition
    | sol.TryCatchClause;

/**
 * Scope corresponding to the current top-level LocalsScope in State.
 * The relationship is fixed at construction, since we store a reference to the
 * underlying map. So if we push more scopes
 */
export class LocalsScope extends BaseLocalsScope {
    constructor(
        public readonly node: LocalsScopeNodeType,
        state: State,
        version: string,
        _next: BaseScope | undefined
    ) {
        const defTypesMap = LocalsScope.detectIds(node, version);

        let name: string;
        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            name = `<block ${node.print(0)}>`;
        } else if (node instanceof sol.VariableDeclarationStatement) {
            name = `<locals ${[...defTypesMap.keys()].join(", ")}>`;
        } else if (node instanceof sol.FunctionDefinition) {
            name = `<args/rets for function ${node.name}>`;
        } else if (node instanceof sol.ModifierDefinition) {
            name = `<args for modifier ${node.name}>`;
        } else {
            name = `<args for try-catch clause#${node.id}>`;
        }

        super(name, defTypesMap, state, _next);
    }

    private static detectIds(
        node: LocalsScopeNodeType,
        version: string
    ): Map<sol.VariableDeclaration, rtt.BaseRuntimeType> {
        const res = new Map<sol.VariableDeclaration, rtt.BaseRuntimeType>();

        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            const ctx = node.requiredContext;
            if (lt(version, "0.5.0")) {
                // In Solidity 0.4.x all state vars have block-wide scope
                for (const stmt of node.vStatements) {
                    if (stmt instanceof sol.VariableDeclarationStatement) {
                        for (const decl of stmt.vDeclarations) {
                            res.set(
                                decl,
                                typeIdToRuntimeType(sol.typeOf(decl), ctx, sol.DataLocation.Memory)
                            );
                        }
                    }
                }
            } else {
                // Nothing to do
            }
        } else if (node instanceof sol.VariableDeclarationStatement) {
            const ctx = node.requiredContext;

            if (lt(version, "0.5.0") && !(node.parent instanceof sol.ForStatement)) {
                // Nothing to do
            } else {
                // In solidity >= 0.5.0 each local variable has a scope starting at its declaration
                // Also if this is the initialization stmt of a for loop, its its own scope
                for (const decl of node.vDeclarations) {
                    res.set(
                        decl,
                        typeIdToRuntimeType(sol.typeOf(decl), ctx, sol.DataLocation.Memory)
                    );
                }
            }
        } else if (node instanceof sol.FunctionDefinition) {
            const ctx = node.requiredContext;

            for (const decl of node.vParameters.vParameters) {
                res.set(decl, typeIdToRuntimeType(sol.typeOf(decl), ctx, undefined));
            }

            for (let i = 0; i < node.vReturnParameters.vParameters.length; i++) {
                const decl = node.vReturnParameters.vParameters[i];
                res.set(decl, typeIdToRuntimeType(sol.typeOf(decl), ctx, undefined));
            }
        } else if (node instanceof sol.ModifierDefinition) {
            const ctx = node.requiredContext;

            for (const decl of node.vParameters.vParameters) {
                res.set(decl, typeIdToRuntimeType(sol.typeOf(decl), ctx, undefined));
            }
        } else {
            const ctx = node.requiredContext;

            if (node.vParameters) {
                for (const decl of node.vParameters.vParameters) {
                    res.set(decl, typeIdToRuntimeType(sol.typeOf(decl), ctx, undefined));
                }
            }
        }

        return res;
    }
}

export class ContractScope extends BaseScope {
    private declToView: Map<sol.VariableDeclaration, View<any, rtt.BaseRuntimeType>>;

    constructor(
        protected readonly contract: sol.ContractDefinition,
        state: State,
        _next: BaseScope | undefined
    ) {
        const ctx = contract.requiredContext;
        const [constVars, normalVars] = gatherStateVars(contract);
        const [layoutType] = getContractLayoutType(contract);
        const layout = makeStorageView(layoutType, [0n, 32]) as StructStorageView;

        const defTypes = new Map<sol.VariableDeclaration, rtt.BaseRuntimeType>();
        const declToView = new Map<sol.VariableDeclaration, View<any, rtt.BaseRuntimeType>>();

        for (const [decl, [name, typ], [, view]] of rtt.zip3(
            normalVars,
            layoutType.fields,
            layout.fieldViews
        )) {
            sol.assert(decl.name === name, ``);
            declToView.set(decl, view as View<any, rtt.BaseRuntimeType>);
            defTypes.set(decl, typ);
        }

        for (const v of constVars) {
            const constView = state.constantsMap.get(v.id);
            sol.assert(
                constView !== undefined,
                `Missing value for constant state var ${contract.name}.${v.name}`
            );
            declToView.set(v, constView as View<any, rtt.BaseRuntimeType>);
            defTypes.set(v, typeIdToRuntimeType(sol.typeOf(v), ctx, sol.DataLocation.Memory));
        }

        super(`<contract ${contract.name}>`, defTypes, state, _next);
        this.declToView = declToView;
    }

    private stateVarViewToValue(view: View<any, rtt.BaseRuntimeType>): Value {
        if (view instanceof BaseMemoryView) {
            // Constant/immutable var
            if (isValueType(view.type)) {
                const res = view.decode(this.state.memory);
                sol.assert(
                    !(res instanceof DecodingFailure),
                    `Unexpected failure decoding constant at ${view.pp()}`
                );
                return res as PrimitiveValue;
            }

            return view;
        }

        if (view instanceof rtt.MapStorageView) {
            return view;
        }

        if (view instanceof PointerStorageView) {
            return view.toView();
        }

        return view.decode(getStateStorage(this.state));
    }

    _lookup(decl: sol.VariableDeclaration): Value | undefined {
        const view = this.declToView.get(decl);

        if (view === undefined) {
            return undefined;
        }

        return this.stateVarViewToValue(view);
    }

    _lookupLocation(decl: sol.VariableDeclaration): View | undefined {
        return this.declToView.get(decl);
    }

    // @todo is this method really necessary? Don't assignments to storage happen through Interpreter.assign?
    _set(decl: sol.VariableDeclaration, v: Value): void {
        const view = this.declToView.get(decl);
        sol.assert(view instanceof BaseStorageView, `Uknown non-constant state var ${decl}`);
        setStateStorage(this.state, view.encode(v, getStateStorage(this.state)));
    }

    public setConst(
        decl: sol.VariableDeclaration,
        v: BaseMemoryView<BaseValue, rtt.BaseRuntimeType>
    ): void {
        this.declToView.set(decl, v as View<any, rtt.BaseRuntimeType>);
    }
}

export class GlobalScope extends BaseScope {
    private viewMap: Map<sol.VariableDeclaration, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;

    private static gatherConstVars(
        unit: sol.SourceUnit,
        res = new Set<sol.VariableDeclaration>()
    ): Set<sol.VariableDeclaration> {
        for (const v of unit.vVariables) {
            res.add(v);
        }

        for (const imp of unit.vImportDirectives) {
            // import * as foo from "..."
            if (imp.unitAlias !== "") {
                // Nothing to do - constants get resolved by evalMemberAccess
            } else if (imp.symbolAliases.length > 0) {
                // import { a, b as c, ...} from "..."
                for (const alias of imp.vSymbolAliases) {
                    const [originalDef] = alias;
                    if (originalDef instanceof sol.VariableDeclaration) {
                        res.add(originalDef);
                    }
                }
            } else {
                // import "foo"
                for (const varDecl of GlobalScope.gatherConstVars(imp.vSourceUnit, res)) {
                    res.add(varDecl);
                }
            }
        }

        return res;
    }

    constructor(
        public readonly unit: sol.SourceUnit,
        state: State,
        _next: BaseScope | undefined
    ) {
        const ctx = unit.requiredContext;
        const defMap = new Map<sol.VariableDeclaration, rtt.BaseRuntimeType>();
        const constVars = GlobalScope.gatherConstVars(unit);

        for (const decl of constVars) {
            const type = typeIdToRuntimeType(sol.typeOf(decl), ctx, sol.DataLocation.Memory);
            defMap.set(decl, type);
        }

        super(`<global scope ${unit.sourceEntryKey}>`, defMap, state, _next);
        this.viewMap = new Map();

        for (const decl of constVars) {
            const view = state.constantsMap.get(decl.id);
            sol.assert(view !== undefined, `Missing view for global constant ${decl.name}`);
            this.viewMap.set(decl, view);
        }
    }

    _lookup(decl: sol.VariableDeclaration): Value | undefined {
        const view = this.viewMap.get(decl);

        if (view === undefined) {
            return undefined;
        }

        if (isValueType(view.type)) {
            const res = view.decode(this.state.memory);
            sol.assert(
                !(res instanceof DecodingFailure),
                `Unexpected failure decoding constant ${decl}`
            );
            return res as PrimitiveValue;
        }

        return view;
    }

    _lookupLocation(decl: sol.VariableDeclaration): View | undefined {
        panic(`Can't get location of ${decl} in GlobalScope`);
    }

    _set(decl: sol.VariableDeclaration): void {
        panic(`Can't set ${decl} in GlobalScope`);
    }

    /**
     * Only called from gatherConstant during constant eval.
     */
    public setConst(
        decl: sol.VariableDeclaration,
        v: BaseMemoryView<BaseValue, rtt.BaseRuntimeType>
    ): void {
        this.viewMap.set(decl, v);
    }
}
