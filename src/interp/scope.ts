import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { BuiltinFunction, BuiltinStruct, DefValue, Value } from "./value";
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
import { ArrayLikeLocalView, PrimitiveLocalView, PointerLocalView } from "./view";
import { defT, getStateStorage, isValueType, panic, setStateStorage } from "./utils";

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
        protected readonly knownIds: Map<string, rtt.BaseRuntimeType>,
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
    | BuiltinFunction
    | sol.TryCatchClause;

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
    ): Map<string, rtt.BaseRuntimeType> {
        const infer = new sol.InferType(version);
        const res = new Map<string, rtt.BaseRuntimeType>();

        if (node instanceof sol.Block || node instanceof sol.UncheckedBlock) {
            if (lt(version, "0.5.0")) {
                // In Solidity 0.4.x all state vars have block-wide scope
                for (const stmt of node.vStatements) {
                    if (stmt instanceof sol.VariableDeclarationStatement) {
                        for (const decl of stmt.vDeclarations) {
                            res.set(
                                decl.name,
                                rtt.astToRuntimeType(
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
                        rtt.astToRuntimeType(
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
                    rtt.astToRuntimeType(
                        infer.variableDeclarationToTypeNode(decl),
                        infer,
                        undefined
                    )
                );
            }

            for (let i = 0; i < node.vReturnParameters.vParameters.length; i++) {
                const decl = node.vReturnParameters.vParameters[i];
                res.set(
                    LocalsScope.returnName(decl, i),
                    rtt.astToRuntimeType(
                        infer.variableDeclarationToTypeNode(decl),
                        infer,
                        undefined
                    )
                );
            }
        } else if (node instanceof sol.ModifierDefinition) {
            for (const decl of node.vParameters.vParameters) {
                res.set(
                    decl.name,
                    rtt.astToRuntimeType(
                        infer.variableDeclarationToTypeNode(decl),
                        infer,
                        undefined
                    )
                );
            }
        } else if (node instanceof sol.TryCatchClause) {
            if (node.vParameters) {
                for (const decl of node.vParameters.vParameters) {
                    res.set(
                        decl.name,
                        rtt.astToRuntimeType(
                            infer.variableDeclarationToTypeNode(decl),
                            infer,
                            undefined
                        )
                    );
                }
            }
        } else {
            for (let i = 0; i < node.type.argTs.length; i++) {
                res.set(`arg_${i}`, node.type.argTs[i]);
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
            name = `<args/rets for function ${node.name}>`;
        } else if (node instanceof sol.ModifierDefinition) {
            name = `<args for modifier ${node.name}>`;
        } else if (node instanceof sol.TryCatchClause) {
            name = `<args for try-catch clause#${node.id}>`;
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

        if (t instanceof rtt.PointerType) {
            return new PointerLocalView(t, [this, name]);
        }

        if (t instanceof rtt.FixedBytesType) {
            return new ArrayLikeLocalView(t, [this, name]);
        }

        return new PrimitiveLocalView(t, [this, name]);
    }

    _set(name: string, val: Value): void {
        this.defs.set(name, val);
    }
}

// @todo should I move this inside the global/contract scope classes?
function defToType(decl: UnitDef, infer: sol.InferType): rtt.BaseRuntimeType {
    // @todo - this ugly struct is temporary until I decide if I need separate types
    // for the type definitions and import defs
    if (decl instanceof sol.VariableDeclaration) {
        // @todo I think loc here should be determine based on the scope of the def?
        return rtt.astToRuntimeType(infer.variableDeclarationToTypeNode(decl), infer);
    } else if (
        decl instanceof sol.ContractDefinition ||
        decl instanceof sol.FunctionDefinition ||
        decl instanceof sol.EventDefinition ||
        decl instanceof sol.ErrorDefinition
    ) {
        return defT;
    } else if (
        decl instanceof sol.StructDefinition ||
        decl instanceof sol.EnumDefinition ||
        decl instanceof sol.UserDefinedValueTypeDefinition
    ) {
        return defT;
    } else {
        return defT;
    }
}

function defToValue(decl: UnitDef): DefValue {
    if (decl instanceof sol.ImportDirective) {
        return new DefValue(decl.vSourceUnit);
    }

    return new DefValue(decl);
}

export class ContractScope extends BaseScope {
    private readonly layoutType: rtt.StructType;
    private readonly layout: StructStorageView;
    private fieldToView: Map<string, BaseStorageView<any, rtt.BaseRuntimeType>>;
    private constFieldToView: Map<string, BaseMemoryView<any, rtt.BaseRuntimeType>>;
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
        const defTypes = new Map<string, rtt.BaseRuntimeType>(layoutType.fields);

        const constVars = contract.vStateVariables.filter(
            (decl) => decl.mutability === sol.Mutability.Constant
        );

        for (const v of constVars) {
            defTypes.set(
                v.name,
                rtt.astToRuntimeType(
                    infer.variableDeclarationToTypeNode(v),
                    infer,
                    sol.DataLocation.Memory
                )
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

        return view.decode(getStateStorage(this.state));
    }

    _lookupLocation(name: string): View | undefined {
        const res = this.fieldToView.get(name);

        if (res !== undefined) {
            return res;
        }

        return this.constFieldToView.get(name);
    }

    // @todo is this method really necessary? Don't assignments to storage happen through Interpreter.assign?
    _set(name: string, v: Value): void {
        const view = this.fieldToView.get(name);
        sol.assert(view !== undefined, `Uknown identifier ${name}`);
        setStateStorage(this.state, view.encode(v, getStateStorage(this.state)));
    }

    public setConst(name: string, v: BaseMemoryView<BaseValue, rtt.BaseRuntimeType>): void {
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
    private viewMap: Map<string, BaseMemoryView<BaseValue, rtt.BaseRuntimeType>>;
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
        const defMap = new Map<string, rtt.BaseRuntimeType>();
        const declMap = GlobalScope.gatherDefs(unit);

        for (const [name, decl] of declMap) {
            const type =
                decl instanceof sol.VariableDeclaration
                    ? rtt.astToRuntimeType(
                          infer.variableDeclarationToTypeNode(decl),
                          infer,
                          sol.DataLocation.Memory
                      )
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
    public setConst(name: string, v: BaseMemoryView<BaseValue, rtt.BaseRuntimeType>): void {
        this.viewMap.set(name, v);
    }
}

export class BuiltinsScope extends BaseScope {
    builtinsMap: Map<string, Value>;

    constructor(
        public readonly builtins: BuiltinStruct,
        state: State,
        _next: BaseScope | undefined
    ) {
        const builtinsFields: Array<[string, rtt.BaseRuntimeType, Value]> = builtins.fields.map(
            ([name, val]) => [name, (val as BuiltinFunction | BuiltinStruct).type, val]
        );
        super(`<builtins>`, new Map(builtinsFields.map((x) => [x[0], x[1]])), state, _next);
        this.builtinsMap = new Map(builtinsFields.map((x) => [x[0], x[2]]));
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
