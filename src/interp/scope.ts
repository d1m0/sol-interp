import * as sol from "solc-typed-ast";
import { BuiltinFunction, DefValue, Value } from "./value";
import { State } from "./state";
import {
    BaseMemoryView,
    ExpStructType,
    getContractLayoutType,
    PointerStorageView,
    simplifyType,
    View,
    Value as BaseValue,
    DecodingFailure,
    PrimitiveValue
} from "sol-dbg";
import { BaseStorageView, makeStorageView, StructStorageView } from "sol-dbg";
import { lt } from "semver";
import { ArrayLikeLocalView, PrimitiveLocalView, PointerLocalView } from "./view";
import { isValueType, panic } from "./utils";

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
    abstract _lookupLocation(name: string): View | undefined;
    abstract _set(name: string, val: Value): void;

    lookup(name: string): Value | undefined {
        let v;

        if (this.knownIds.has(name)) {
            v = this._lookup(name);
        } else {
            v = this._next ? this._next.lookup(name) : undefined;
        }

        return v;
    }

    lookupLocation(name: string): View | undefined {
        let v;

        if (this.knownIds.has(name)) {
            v = this._lookupLocation(name);
        } else {
            v = this._next ? this._next.lookupLocation(name) : undefined;
        }

        return v;
    }

    set(name: string, val: Value): void {
        if (this.knownIds.has(name)) {
            this._set(name, val);
            return;
        }

        if (this._next === undefined) {
            return;
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
    | sol.ModifierDefinition
    | BuiltinFunction;

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
                            res.set(
                                decl.name,
                                simplifyType(
                                    infer.variableDeclarationToTypeNode(decl),
                                    infer,
                                    sol.DataLocation.Memory
                                )
                            );
                        }
                    }
                }
            } else {
                // Nothing to do
            }
        } else if (node instanceof sol.VariableDeclarationStatement) {
            if (lt(version, "0.5.0") && !(node.parent instanceof sol.ForStatement)) {
                // Nothing to do
            } else {
                // In solidity >= 0.5.0 each local variable has a scope starting at its declaration
                // Also if this is the initialization stmt of a for loop, its its own scope
                for (const decl of node.vDeclarations) {
                    res.set(
                        decl.name,
                        simplifyType(
                            infer.variableDeclarationToTypeNode(decl),
                            infer,
                            sol.DataLocation.Memory
                        )
                    );
                }
            }
        } else if (node instanceof sol.FunctionDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.set(
                    decl.name,
                    simplifyType(infer.variableDeclarationToTypeNode(decl), infer, undefined)
                );
            }

            for (let i = 0; i < node.vReturnParameters.vParameters.length; i++) {
                const decl = node.vReturnParameters.vParameters[i];
                res.set(
                    LocalsScope.returnName(decl, i),
                    simplifyType(infer.variableDeclarationToTypeNode(decl), infer, undefined)
                );
            }
        } else if (node instanceof sol.ModifierDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.set(
                    decl.name,
                    simplifyType(infer.variableDeclarationToTypeNode(decl), infer, undefined)
                );
            }
        } else {
            for (let i = 0; i < node.type.parameters.length; i++) {
                res.set(`arg_${i}`, simplifyType(node.type.parameters[i], infer, undefined));
            }
        }

        return res;
    }

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
            name = `<args/rets for ${node.print(0)}>`;
        } else if (node instanceof sol.ModifierDefinition) {
            name = `<args for ${node.print(0)}>`;
        } else {
            name = `<args for ${node.pp()}>`;
        }

        super(name, defTypesMap, state, _next);
        this.defs = new Map();
    }

    _lookup(name: string): Value | undefined {
        return this.defs.get(name);
    }

    _lookupLocation(name: string): View | undefined {
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

export function defToType(decl: UnitDef, infer: sol.InferType): sol.TypeNode {
    if (decl instanceof sol.VariableDeclaration) {
        return infer.variableDeclarationToTypeNode(decl);
    } else if (decl instanceof sol.ContractDefinition) {
        return new sol.TypeNameType(new sol.UserDefinedType(decl.name, decl));
    } else if (decl instanceof sol.FunctionDefinition) {
        return infer.funDefToType(decl);
    } else if (decl instanceof sol.EventDefinition) {
        return infer.eventDefToType(decl);
    } else if (decl instanceof sol.ErrorDefinition) {
        return infer.errDefToType(decl);
    } else if (
        decl instanceof sol.StructDefinition ||
        decl instanceof sol.EnumDefinition ||
        decl instanceof sol.UserDefinedValueTypeDefinition
    ) {
        return new sol.TypeNameType(new sol.UserDefinedType(decl.name, decl));
    } else {
        return new sol.ImportRefType(decl);
    }
}

function defToValue(decl: UnitDef): DefValue {
    if (decl instanceof sol.ImportDirective) {
        return new DefValue(decl.vSourceUnit);
    }

    return new DefValue(decl);
}

export class ContractScope extends BaseScope {
    private readonly layoutType: ExpStructType;
    private readonly layout: StructStorageView;
    private fieldToView: Map<string, BaseStorageView<any, sol.TypeNode>>;
    private constFieldToView: Map<string, BaseMemoryView<any, sol.TypeNode>>;
    private defMap: Map<string, DefValue>;

    private static gatherDefs(contract: sol.ContractDefinition): Map<string, UnitDef> {
        const res = new Map<string, UnitDef>();

        for (const d of contract.vFunctions) {
            res.set(d.name, d);
        }

        for (const d of contract.vEvents) {
            res.set(d.name, d);
        }

        for (const d of contract.vErrors) {
            res.set(d.name, d);
        }

        for (const d of contract.vStructs) {
            res.set(d.name, d);
        }

        for (const d of contract.vEnums) {
            res.set(d.name, d);
        }

        for (const d of contract.vUserDefinedValueTypes) {
            res.set(d.name, d);
        }

        return res;
    }

    constructor(
        protected readonly contract: sol.ContractDefinition,
        infer: sol.InferType,
        state: State,
        _next: BaseScope | undefined
    ) {
        const [layoutType] = getContractLayoutType(contract, infer);
        const defTypes = new Map<string, sol.TypeNode>(layoutType.fields);

        const constVars = contract.vStateVariables.filter(
            (decl) => decl.mutability === sol.Mutability.Constant
        );

        for (const v of constVars) {
            defTypes.set(
                v.name,
                simplifyType(infer.variableDeclarationToTypeNode(v), infer, sol.DataLocation.Memory)
            );
        }

        const defMap = ContractScope.gatherDefs(contract);
        for (const [name, def] of defMap) {
            if (def instanceof sol.VariableDeclaration) {
                // Handled above
                continue;
            }

            defTypes.set(name, defToType(def, infer));
        }

        super(`<contract ${contract.name}>`, defTypes, state, _next);
        this.layoutType = layoutType;
        this.layout = makeStorageView(this.layoutType, [0n, 32]) as StructStorageView;
        this.fieldToView = new Map(this.layout.fieldViews);

        this.constFieldToView = new Map();
        for (const v of constVars) {
            const constView = state.constantsMap.get(v.id);
            sol.assert(
                constView !== undefined,
                `Missing value for constant state var ${contract.name}.${v.name}`
            );
            this.constFieldToView.set(v.name, constView);
        }

        this.defMap = new Map([...defMap.entries()].map(([name, def]) => [name, defToValue(def)]));
    }

    private _lookupConst(name: string): Value | undefined {
        const view = this.constFieldToView.get(name);

        if (view === undefined) {
            return this.defMap.get(name);
        }

        if (isValueType(view.type)) {
            const res = view.decode(this.state.memory);
            sol.assert(
                !(res instanceof DecodingFailure),
                `Unexpected failure decoding constant ${name}`
            );
            return res as PrimitiveValue;
        }

        return view;
    }

    _lookup(name: string): Value | undefined {
        const view = this.fieldToView.get(name);

        if (view === undefined) {
            return this._lookupConst(name);
        }

        if (view instanceof PointerStorageView) {
            return view.toView();
        }

        return view.decode(this.state.account.storage);
    }

    _lookupLocation(name: string): View | undefined {
        return this.fieldToView.get(name) as any;
    }

    _set(name: string, v: Value): void {
        const view = this.fieldToView.get(name) as BaseStorageView<any, sol.TypeNode>;
        this.state.account.storage = view.encode(v, this.state.account.storage);
    }

    public setConst(name: string, v: BaseMemoryView<BaseValue, sol.TypeNode>): void {
        this.constFieldToView.set(name, v);
    }
}

type UnitDef =
    | sol.ContractDefinition
    | sol.ImportDirective
    | sol.FunctionDefinition
    | sol.EventDefinition
    | sol.ErrorDefinition
    | sol.StructDefinition
    | sol.EnumDefinition
    | sol.UserDefinedValueTypeDefinition;

function isUnitDef(n: sol.ASTNode): n is UnitDef {
    return (
        n instanceof sol.ContractDefinition ||
        n instanceof sol.ImportDirective ||
        n instanceof sol.FunctionDefinition ||
        n instanceof sol.EventDefinition ||
        n instanceof sol.ErrorDefinition ||
        n instanceof sol.StructDefinition ||
        n instanceof sol.EnumDefinition ||
        n instanceof sol.UserDefinedValueTypeDefinition
    );
}

export class GlobalScope extends BaseScope {
    private viewMap: Map<string, BaseMemoryView<BaseValue, sol.TypeNode>>;
    private defMap: Map<string, DefValue>;

    private static gatherDefs(
        unit: sol.SourceUnit,
        res = new Map<string, sol.VariableDeclaration | UnitDef>()
    ): Map<string, sol.VariableDeclaration | UnitDef> {
        for (const v of unit.vVariables) {
            res.set(v.name, v);
        }

        for (const imp of unit.vImportDirectives) {
            // import * as foo from "..."
            if (imp.unitAlias !== "") {
                // Nothing to do - constants get resolved by evalMemberAccess
                res.set(imp.unitAlias, imp);
            } else if (imp.symbolAliases.length > 0) {
                // import { a, b as c, ...} from "..."
                for (const alias of imp.vSymbolAliases) {
                    const [originalDef, newName] = alias;
                    if (originalDef instanceof sol.VariableDeclaration || isUnitDef(originalDef)) {
                        const name =
                            newName === undefined
                                ? originalDef instanceof sol.ImportDirective
                                    ? originalDef.unitAlias
                                    : originalDef.name
                                : newName;
                        res.set(name, originalDef);
                    }
                }
            } else {
                // import "foo"
                res = GlobalScope.gatherDefs(imp.vSourceUnit, res);
            }
        }

        for (const d of unit.vContracts) {
            res.set(d.name, d);
        }

        for (const d of unit.vFunctions) {
            res.set(d.name, d);
        }

        for (const d of unit.vEvents) {
            res.set(d.name, d);
        }

        for (const d of unit.vErrors) {
            res.set(d.name, d);
        }

        for (const d of unit.vStructs) {
            res.set(d.name, d);
        }

        for (const d of unit.vEnums) {
            res.set(d.name, d);
        }

        for (const d of unit.vUserDefinedValueTypes) {
            res.set(d.name, d);
        }

        return res;
    }

    constructor(
        public readonly unit: sol.SourceUnit,
        state: State,
        infer: sol.InferType,
        _next: BaseScope | undefined
    ) {
        const defMap = new Map<string, sol.TypeNode>();
        const declMap = GlobalScope.gatherDefs(unit);

        for (const [name, decl] of declMap) {
            const type =
                decl instanceof sol.VariableDeclaration
                    ? infer.variableDeclarationToTypeNode(decl)
                    : defToType(decl, infer);
            defMap.set(name, type);
        }

        super(`<global scope ${unit.sourceEntryKey}>`, defMap, state, _next);
        this.viewMap = new Map();
        this.defMap = new Map();

        for (const [name, decl] of declMap) {
            if (decl instanceof sol.VariableDeclaration) {
                const view = state.constantsMap.get(decl.id);
                sol.assert(view !== undefined, `Missing view for global constant ${name}`);
                this.viewMap.set(name, view);
            } else {
                this.defMap.set(name, defToValue(decl));
            }
        }
    }

    _lookup(name: string): Value | undefined {
        const view = this.viewMap.get(name);
        if (view === undefined) {
            return this.defMap.get(name);
        }

        if (isValueType(view.type)) {
            const res = view.decode(this.state.memory);
            sol.assert(
                !(res instanceof DecodingFailure),
                `Unexpected failure decoding constant ${name}`
            );
            return res as PrimitiveValue;
        }

        return view;
    }

    _lookupLocation(name: string): View | undefined {
        panic(`Can't get location of ${name} in GlobalScope`);
    }

    _set(name: string): void {
        panic(`Can't set ${name} in GlobalScope`);
    }

    /**
     * Only called from gatherConstant during constant eval.
     */
    public setConst(name: string, v: BaseMemoryView<BaseValue, sol.TypeNode>): void {
        this.viewMap.set(name, v);
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

    _lookupLocation(): View | undefined {
        sol.assert(false, `Can't lookup a builtin's location`);
    }

    _set(): void {
        sol.assert(false, `Can't set a builtin after initialization`);
    }
}
