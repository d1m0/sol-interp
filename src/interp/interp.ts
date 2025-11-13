import {
    DecodingFailure,
    IntMemView,
    isArrayLikeCalldataView,
    isArrayLikeMemView,
    isArrayLikeStorageView,
    nyi,
    PointerCalldataView,
    PointerMemView,
    PointerStorageView,
    Poison,
    View,
    Value as BaseValue,
    StructMemView,
    StructCalldataView,
    StructStorageView,
    PrimitiveValue,
    makeMemoryView,
    bigIntToNum,
    ArrayMemView,
    MapStorageView,
    StringMemView,
    BytesMemView,
    StringStorageView,
    BytesStorageView,
    MAX_ARR_DECODE_LIMIT,
    stackTop,
    ArtifactInfo,
    isPoison,
    buildMsgViews
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as rtt from "sol-dbg";
import { WorldInterface, State, SolMessage, CallResult, makeBuiltinScope } from "./state";
import {
    InternalError,
    NoScope,
    NotDefined,
    OOBError,
    OverflowError,
    RuntimeError,
    PANIC_SELECTOR,
    ERROR_SELECTOR,
    PanicError,
    CustomError,
    NoPayloadError
} from "./exceptions";
import { gte, lt } from "semver";
import {
    BaseTypeValue,
    BuiltinFunction,
    BuiltinStruct,
    BytesStorageLength,
    DefValue,
    ExternalCallDescription,
    isPrimitiveValue,
    LValue,
    match,
    NewCall,
    none,
    NonPoisonValue,
    TypeConstructorToValueType,
    TypeTuple,
    TypeValue,
    typeValueToType,
    Value,
    ValueTypeConstructors
} from "./value";
import {
    Address,
    bigIntToBytes,
    bytesToHex,
    concatBytes,
    equalsBytes,
    hexToBytes,
    setLengthLeft,
    setLengthRight
} from "@ethereumjs/util";
import {
    BaseScope,
    BuiltinsScope,
    ContractScope,
    GlobalScope,
    LocalsScope,
    TempsScope
} from "./scope";
import {
    bytes32,
    bytesT,
    bytesToIntOfType,
    cdBytesT,
    changeLocTo,
    clampIntToType,
    decodeView,
    defT,
    deref,
    getCodeContract,
    getCodeContractInfo,
    getContract,
    getContractInfo,
    getExternalCallComponents,
    getGetterArgAndReturnTs,
    getLibraryLinkedAddress,
    getModifiers,
    getMsg,
    getMsgSender,
    getStateStorage,
    getThis,
    indexOfEnumOption,
    int256,
    isBaseOf,
    isDirectlyAssignable,
    isMethod,
    isStructView,
    isValueType,
    length,
    liftExtCalRef,
    makeZeroValue,
    memBytesT,
    memStringT,
    printNode,
    removeLiteralTypes,
    setStateStorage,
    solcValueToValue,
    stringT,
    typeOfView,
    unwrapUnaryTypeTuples
} from "./utils";
import { BaseStorageView, BaseMemoryView, BaseCalldataView } from "sol-dbg";
import {
    BaseLocalView,
    ArrayLikeLocalView,
    isArrayLikeView,
    isPointerView,
    PointerLocalView,
    MsgDataView
} from "./view";
import { ppLValue, ppValue, ppValueTypeConstructor } from "./pp";
import {
    ADDRESS_BUILTIN_STRUCT_NAME,
    EXTERNAL_CALL_CALLABLE_FIELDS_NAME,
    popBuiltin,
    pushBuiltin,
    revertBuiltin
} from "./builtins";
import { ArtifactManager } from "./artifactManager";
import { decode, decodesWithSelector, encode, skipFieldDueToMap } from "./abi";
import { astToRuntimeType, BaseInterpType } from "./types";
import { InterpVisitor } from "./visitors";
import { castStringToBytes, decodeLinkMap } from "sol-dbg/dist/debug/decoding/utils";

enum ControlFlow {
    Fallthrough = 0,
    Break = 1,
    Continue = 2,
    Return = 3
}

const scratchWord = new Uint8Array(32);

/**
 * Solidity Interpeter class. Includes the following entrypoints
 *
 * * evaluate a single expression
 *      `eval(expr: sol.Expression, state: State): Value`
 * * execute one statement
 *      `exec(stmt: sol.Statement, state: State): ControlFlow`
 * * call an internal function
 *      `callInternal(callee: sol.FunctionDefinition, args: Value[], state: State)`
 * * call an external method
 *      `call(msg: SolMessage, state: State): Uint8Array | RuntimeError`
 *
 * Most of the Interpreter state is kept in the `State` object that is passed around. The only runtime state
 * this class maintains is mostly for debugging purposes:
 *  - AST node stack of currently executed/evaluated objects
 */
export class Interpreter {
    nodes: Array<sol.ASTNode | BuiltinFunction>;

    get compilerVersion(): string {
        return this.artifact.compilerVersion;
    }

    _infer: sol.InferType;

    constructor(
        public readonly world: WorldInterface,
        public readonly artifactManager: ArtifactManager,
        public readonly artifact: ArtifactInfo,
        private readonly visitors: InterpVisitor[]
    ) {
        this.nodes = [];
        this._infer = new sol.InferType(this.compilerVersion);
    }

    get curNode(): sol.ASTNode | BuiltinFunction {
        sol.assert(this.nodes.length > 0, `No cur node`);
        return this.nodes[this.nodes.length - 1];
    }

    /**
     * An internal interpreter exception. This indicates a bug in the interpreter
     */
    fail(
        errorConstr: new (...args: any[]) => InternalError,
        msg: string,
        ctx: sol.ASTNode | BuiltinFunction = this.curNode
    ): never {
        throw new errorConstr(ctx, msg);
    }

    /**
     * A runtime error. This indicates an actual EVM exception at runtime
     */
    runtimeError(
        errorConstr: new (...args: any[]) => RuntimeError,
        state: State,
        ...args: any[]
    ): never {
        const err = new errorConstr(this.curNode, ...args);
        for (const v of this.visitors) {
            v.exception(this, state, err);
        }
        throw err;
    }

    astToRuntimeType(t: sol.TypeNode, loc?: sol.DataLocation): BaseInterpType {
        return astToRuntimeType(t, this._infer, loc);
    }

    varDeclToRuntimeType(decl: sol.VariableDeclaration): BaseInterpType {
        return rtt.astToRuntimeType(this._infer.variableDeclarationToTypeNode(decl), this._infer);
    }

    isConstant(e: sol.Expression): boolean {
        if (
            (e instanceof sol.Identifier || e instanceof sol.MemberAccess) &&
            e.vReferencedDeclaration instanceof sol.VariableDeclaration &&
            e.vReferencedDeclaration.mutability === sol.Mutability.Constant
        ) {
            return true;
        }

        if (
            e instanceof sol.FunctionCall &&
            e.kind === sol.FunctionCallKind.TypeConversion &&
            this.isConstant(e.vArguments[0])
        ) {
            return true;
        }

        return false;
    }

    typeOf(e: sol.Expression): BaseInterpType {
        const solT = removeLiteralTypes(this._infer.typeOf(e), e, this._infer);

        // Detect global ref type constants (strings, bytes) and treat them as stored in memory
        const loc: sol.DataLocation | undefined = this.isConstant(e)
            ? sol.DataLocation.Memory
            : undefined;

        return this.astToRuntimeType(solT, loc);
    }

    ///*********************EXTERNAL FUNCTION CALLS************************************
    private getCalldataArgsAndTypes(
        entryPoint: sol.FunctionDefinition | sol.VariableDeclaration,
        data: Uint8Array,
        base?: bigint
    ): [PrimitiveValue[], BaseInterpType[]] {
        const contract = entryPoint.vScope;
        this.expect(contract instanceof sol.ContractDefinition);

        // Fallbacks are a special case with an (optional) single arg which is a MsgDataView
        if (
            entryPoint instanceof sol.FunctionDefinition &&
            entryPoint.kind === sol.FunctionKind.Fallback
        ) {
            if (entryPoint.vParameters.vParameters.length === 0) {
                return [[], []];
            }

            return [[new MsgDataView()], [cdBytesT]];
        }

        // Decode args
        let calldataViews: Array<View<rtt.Memory>> = buildMsgViews(
            entryPoint,
            this._infer,
            base
        ).map((x) => x[1]);

        // Skip selector
        if (rtt.hasSelector(entryPoint)) {
            calldataViews = calldataViews.slice(1);
        }

        let argTs: BaseInterpType[];
        if (entryPoint instanceof sol.FunctionDefinition) {
            const isLib = contract.kind === sol.ContractKind.Library;

            // The arg values here are calldata pointers, which may differ from
            // the actual arguments (i.e. they may be memory pointers).  The
            // `Intepreter.assign` in `makeScope()` will handle the copying from
            // calldata to memory.
            argTs = entryPoint.vParameters.vParameters.map((argT) => {
                const declT = this.varDeclToRuntimeType(argT);

                if (
                    isLib &&
                    declT instanceof rtt.PointerType &&
                    declT.location === sol.DataLocation.Storage
                ) {
                    return declT;
                }

                return rtt.specializeType(rtt.generalizeType(declT), sol.DataLocation.CallData);
            });
        } else {
            argTs = getGetterArgAndReturnTs(entryPoint, this._infer)[0];
        }

        const calldataArgs: PrimitiveValue[] = calldataViews.map((view, i) => {
            const argT = argTs[i];

            if (argT instanceof rtt.PointerType && argT.location === sol.DataLocation.Storage) {
                const v = view.decode(data);
                sol.assert(typeof v === "bigint", `Expected bigint for struct pointer not ${v}`);
                return rtt.makeStorageView(argT.toType, [v, 32]);
            }

            if (isValueType(argT)) {
                return view.decode(data) as PrimitiveValue;
            }

            if (view instanceof PointerCalldataView) {
                const innerView = view.toView(data);
                this.expect(
                    innerView instanceof BaseCalldataView,
                    `Unexpected pointer calldata view`
                );
                return innerView;
            }

            sol.assert(false, `Unexpected calldata arg ${ppValue(view)}`);
        });

        return [calldataArgs, argTs];
    }

    /**
     * Entry point to initialize a new contract. Note that the msg.data is the complete msg.data
     * including the creation bytecode.
     * @param msg
     * @param state
     */
    public create(msg: SolMessage, state: State): Uint8Array | RuntimeError {
        state.msg = msg;

        for (const v of this.visitors) {
            v.call(this, state, msg);
        }

        const mdc = getContractInfo(state);
        this.expect(mdc.ast !== undefined, `Can't create a contract with no AST`);
        const bases = mdc.ast.vLinearizedBaseContracts.toReversed();

        // Compute the link map from the artifact's bytecode and the actual msg.data
        const linkMap = decodeLinkMap(mdc.bytecode, state.msg.data);

        // Compute the linked bytecode and deployed bytecode
        state.partialDeployedBytecode = this.artifactManager.link(mdc.deployedBytecode, linkMap);

        // We assume that the caller has created and initialized state.account
        // If there are arguments to be passed, then the target MDC must have a constructor
        this.expect(
            msg.data.length === mdc.bytecode.bytecode.length ||
            (mdc.ast.vConstructor !== undefined &&
                mdc.ast.vConstructor.vParameters.vParameters.length > 0)
        );

        try {
            // As per:
            // https://docs.soliditylang.org/en/v0.8.30/ir-breaking-changes.html#semantic-only-changes
            // Contract initialization proceeds by:
            if (mdc.artifact.codegen === "old") {
                // For old codegen:
                //
                // 1. All state variables are zero-initialized at the beginning.
                // 2. Initialize all state variables in the whole inheritance hierarchy from most base to most derived.
                for (const base of bases) {
                    for (const v of base.vStateVariables) {
                        this.initializeStateVar(v, state);
                    }
                }

                // 3. Evaluate base constructor arguments from most derived to most base contract.
                const baseArgMap = this.evalBaseConstructorArgs(mdc.ast, state);

                if (mdc.ast.vConstructor) {
                    const [calldataArgs, argTs] = this.getCalldataArgsAndTypes(
                        mdc.ast.vConstructor,
                        msg.data,
                        BigInt(mdc.bytecode.bytecode.length)
                    );
                    baseArgMap.set(mdc.ast.vConstructor, [calldataArgs, argTs]);
                }

                // 4. Run the constructor, if present, for all contracts in the linearized hierarchy from most base to most derived.
                for (const base of bases) {
                    if (!base.vConstructor) {
                        continue;
                    }

                    this.nodes.push(base.vConstructor);
                    const argDesc = baseArgMap.get(base.vConstructor);
                    this.expect(argDesc !== undefined, `Missing constructor args for ${base.name}`);
                    const [args, argTs] = argDesc;
                    this._execCall(base.vConstructor, args, argTs, state);
                    this.nodes.pop();
                }
            } else {
                // For IR codegen:
                //
                // 1. All state variables are zero-initialized at the beginning.
                // 2. Evaluate base constructor arguments from most derived to most base contract.
                const baseArgMap = this.evalBaseConstructorArgs(mdc.ast, state);

                // 3. For every contract in order from most base to most derived in the linearized hierarchy:
                for (const base of bases) {
                    // 1. Initialize state variables.
                    for (const v of base.vStateVariables) {
                        this.initializeStateVar(v, state);
                    }

                    // 2. Run the constructor (if present).
                    if (!base.vConstructor) {
                        continue;
                    }

                    this.nodes.push(base.vConstructor);
                    const argDesc = baseArgMap.get(base.vConstructor);
                    this.expect(argDesc !== undefined, `Missing constructor args for ${base.name}`);
                    const [args, argTs] = argDesc;
                    this._execCall(base.vConstructor, args, argTs, state);
                    this.nodes.pop();
                }
            }
        } catch (e) {
            if (e instanceof RuntimeError) {
                return e;
            }

            throw e;
        }

        const deployedBytecode = state.partialDeployedBytecode;

        for (const v of this.visitors) {
            v.return(this, state, deployedBytecode);
        }

        state.account.deployedBytecode = deployedBytecode;

        // If we succeed update the world on our new state
        this.world.updateAccount(state.account);

        // @todo implement immutables
        return deployedBytecode;
    }

    /**
     * Main entrypoint to the conctract. Responsible for:
     *  - dispatching to the correct function
     *  - decoding arguments from calldata
     */
    public call(msg: SolMessage, state: State): Uint8Array | RuntimeError {
        state.msg = msg;

        for (const v of this.visitors) {
            v.call(this, state, msg);
        }

        const codeInfo = getCodeContractInfo(state);
        this.expect(codeInfo !== undefined && codeInfo.ast !== undefined);
        // This handles dispatch including fallback and receive functions.
        const entryPoint = this.artifactManager.findEntryPoint(msg.data, codeInfo);

        if (entryPoint === undefined) {
            return new NoPayloadError(codeInfo.ast);
        }

        // Decode Arguments
        const [calldataArgs, argTs] = this.getCalldataArgsAndTypes(entryPoint, getMsg(state));
        let res: Value[];
        let resTs: rtt.BaseRuntimeType[];

        // Execute actual call
        try {
            if (entryPoint instanceof sol.FunctionDefinition) {
                res = this.callInternal(entryPoint, calldataArgs, argTs, state);
                resTs = entryPoint.vReturnParameters.vParameters.map((retT) =>
                    this.varDeclToRuntimeType(retT)
                );
            } else {
                res = this.callGetter(entryPoint, calldataArgs, argTs, state);
                resTs = getGetterArgAndReturnTs(entryPoint, this._infer)[1];
            }
        } catch (e) {
            if (e instanceof RuntimeError) {
                return e;
            }

            throw e;
        }

        let resData: Uint8Array;

        if (
            entryPoint instanceof sol.FunctionDefinition &&
            entryPoint.kind === sol.FunctionKind.Fallback
        ) {
            // Fallback functions return data without it being encoded
            if (res.length == 1) {
                this.expect(res[0] instanceof View && res[0].type instanceof rtt.BytesType);
                resData = decodeView(res[0], state) as Uint8Array;
            } else {
                this.expect(res.length === 0);
                resData = new Uint8Array();
            }
        } else {
            // Encode returns
            resData = encode(res, resTs, state);
        }

        for (const v of this.visitors) {
            v.return(this, state, resData);
        }

        // If we succeed update the world on our new state
        this.world.updateAccount(state.account);

        return resData;
    }

    private pushScope(node: sol.ASTNode, vals: Array<[string, Value]>, state: State): void {
        if (
            node instanceof sol.FunctionDefinition ||
            node instanceof sol.ModifierDefinition ||
            node instanceof sol.Block ||
            node instanceof sol.UncheckedBlock ||
            node instanceof sol.VariableDeclarationStatement ||
            node instanceof sol.TryCatchClause
        ) {
            const newScope = new LocalsScope(node, state, this.compilerVersion, state.scope);

            // Add arguments to store
            for (const [name, val] of vals) {
                newScope.set(name, val);
            }

            state.scope = newScope;
            // console.error(`Push scope ${newScope.name} with vals ${vals.map(([n, v]) => `${n}: ${ppValue(v)}`).join(", ")}`)

            return;
        }

        nyi(`Scope node ${node.print(0)}`);
    }

    private popScope(state: State): void {
        this.expect(state.scope !== undefined, `Popping on empty scope`);
        state.scope = state.scope?._next;
    }

    ///*********************Constructors **********************************************
    /**
     * Evaluate the inline initializer (if any) for the given state variable and assign it.
     * @param v
     */
    private initializeStateVar(v: sol.VariableDeclaration, s: State): void {
        this.expect(v.stateVariable && v.vScope instanceof sol.ContractDefinition);
        this.nodes.push(v);
        if (v.vValue === undefined || v.mutability === sol.Mutability.Constant) {
            return;
        }

        const oldScope = s.scope;
        s.scope = this.makeStaticScope(v.vScope, s);

        const initalVal = this.eval(v.vValue, s);
        const varLoc = s.scope.lookupLocation(v.name);
        this.expect(varLoc !== undefined);
        this.assign(varLoc, initalVal, s);
        s.scope = oldScope;
        this.nodes.pop();
    }

    /**
     * Evaluate the base constructor args for all bases of `mdc` from most-derived to most base contract.
     * Note that:
     *  - Inheirtance speicifiers are evaluated in the containing source unit scope
     *  - Constructor modifiers are evaluated in the conrtact scope
     * @param mdc
     * @param s
     */
    private evalBaseConstructorArgs(
        mdc: sol.ContractDefinition,
        s: State
    ): Map<sol.FunctionDefinition, [Value[], BaseInterpType[]]> {
        const res = new Map<sol.FunctionDefinition, [Value[], BaseInterpType[]]>();
        const oldScope = s.scope;

        for (const base of mdc.vLinearizedBaseContracts) {
            const curBaseArgs = new Map<sol.FunctionDefinition, [Value[], BaseInterpType[]]>();

            for (const inhSpec of base.vInheritanceSpecifiers) {
                s.scope = this.makeStaticScope(base.vScope, s);
                const baseContract = inhSpec.vBaseType.vReferencedDeclaration;
                this.expect(baseContract instanceof sol.ContractDefinition);

                if (baseContract.vConstructor === undefined) {
                    continue;
                }

                // In solidity <0.5.0 you could specify arguments for the same base multiple times.
                // Only the first one in the C3-linearization order counts.
                if (res.has(baseContract.vConstructor)) {
                    continue;
                }

                const args: Value[] = [];
                const argTs: BaseInterpType[] = [];

                for (let i = 0; i < inhSpec.vArguments.length; i++) {
                    args.push(this.eval(inhSpec.vArguments[i], s));
                    argTs.push(this.typeOf(inhSpec.vArguments[i]));
                }

                curBaseArgs.set(baseContract.vConstructor, [args, argTs]);
            }

            if (base.vConstructor) {
                s.scope = this.makeStaticScope(base.vConstructor, s);

                for (const mod of base.vConstructor.vModifiers) {
                    if (
                        !(
                            mod.vModifier instanceof sol.ContractDefinition &&
                            mod.vModifier.vConstructor !== undefined
                        )
                    ) {
                        continue;
                    }

                    const constr = mod.vModifier.vConstructor;
                    const args: Value[] = [];
                    const argTs: BaseInterpType[] = [];

                    // In solidity <0.5.0 you could specify arguments for the same base multiple times.
                    // Only the first one in the C3-linearization order counts.
                    if (res.has(constr)) {
                        continue;
                    }

                    for (let i = 0; i < mod.vArguments.length; i++) {
                        args.push(this.eval(mod.vArguments[i], s));
                        argTs.push(this.typeOf(mod.vArguments[i]));
                    }

                    curBaseArgs.set(constr, [args, argTs]);
                }
            }

            for (const [constr, rest] of curBaseArgs) {
                res.set(constr, rest);
            }
        }

        s.scope = oldScope;
        return res;
    }

    ///*********************MODIFIERS/INTERNAL FUNCTION CALLS**************************

    public callGetter(
        callee: sol.VariableDeclaration,
        args: PrimitiveValue[],
        argTs: BaseInterpType[],
        state: State
    ): Value[] {
        this.nodes.push(callee);
        const scope = this.makeStaticScope(callee, state);
        const storage = getStateStorage(state);
        let stateVarView:
            | BaseStorageView<BaseValue, rtt.BaseRuntimeType>
            | BaseMemoryView<BaseValue, rtt.BaseRuntimeType>
            | DecodingFailure
            | undefined = scope.lookupLocation(callee.name) as
            | BaseStorageView<BaseValue, rtt.BaseRuntimeType>
            | undefined;
        this.expect(stateVarView !== undefined, `No state var ${callee.name}`);

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (
                stateVarView instanceof PointerStorageView &&
                stateVarView.innerView instanceof rtt.ArrayStorageView
            ) {
                this.expect(
                    typeof arg === "bigint",
                    `Wrong argument type ${typeof args[i]} for array`
                );
                stateVarView = stateVarView.innerView.indexView(arg, storage);
                this.expect(!(stateVarView instanceof DecodingFailure), `Failed indexing`);
            } else {
                this.expect(
                    stateVarView instanceof PointerStorageView &&
                    stateVarView.innerView instanceof MapStorageView
                );
                stateVarView = stateVarView.innerView.indexView(arg);
                this.expect(!(stateVarView instanceof DecodingFailure), `Failed indexing`);
            }
        }

        let returnViews =
            stateVarView instanceof PointerStorageView &&
                stateVarView.innerView instanceof StructStorageView
                ? stateVarView.innerView.fieldViews.map(([, fv]) => fv)
                : [stateVarView];

        // Skip toplevel arrays and maps in structs
        returnViews = returnViews.filter(
            (v) =>
                !(
                    v instanceof rtt.PointerStorageView &&
                    (v.innerView instanceof rtt.ArrayStorageView ||
                        v.innerView instanceof MapStorageView)
                )
        );

        // Decode any primitive values
        const returnVals: Value[] = returnViews.map((v) => {
            if (isValueType(v.type)) {
                const t = v.decode(storage);
                this.expect(isPrimitiveValue(t), ``);
                return t;
            }

            if (isPointerView(v)) {
                return deref(v, state);
            }

            return v;
        });

        this.nodes.pop();
        return returnVals;
    }

    /**
     * Make an internal call to `callee` with arguments `args` in state `state`.
     * @param callee
     * @param args
     * @param state
     */
    public callInternal(
        callee: sol.FunctionDefinition,
        args: Value[],
        argTs: BaseInterpType[],
        state: State
    ): Value[] {
        return this._execCall(callee, args, argTs, state);
    }

    ///*********************STATEMENTS*************************************************
    public exec(stmt: sol.Statement, state: State): ControlFlow {
        // console.error(`exec: ${printNode(stmt)}`)
        let res: ControlFlow;

        this.nodes.push(stmt);

        if (stmt instanceof sol.Block || stmt instanceof sol.UncheckedBlock) {
            res = this.execBlock(stmt, state);
        } else if (stmt instanceof sol.ExpressionStatement) {
            res = this.execExpressionStatement(stmt, state);
        } else if (stmt instanceof sol.VariableDeclarationStatement) {
            res = this.execVariableDeclarationStatement(stmt, state);
        } else if (stmt instanceof sol.Return) {
            res = this.execReturn(stmt, state);
        } else if (stmt instanceof sol.IfStatement) {
            res = this.execIfStatement(stmt, state);
        } else if (stmt instanceof sol.WhileStatement) {
            res = this.execWhileStatement(stmt, state);
        } else if (stmt instanceof sol.Break) {
            res = this.execBreak();
        } else if (stmt instanceof sol.Continue) {
            res = this.execContinue();
        } else if (stmt instanceof sol.DoWhileStatement) {
            res = this.execDoWhileStatement(stmt, state);
        } else if (stmt instanceof sol.ForStatement) {
            res = this.execForStatement(stmt, state);
        } else if (stmt instanceof sol.PlaceholderStatement) {
            res = this.execPlaceholderStatement(stmt, state);
        } else if (stmt instanceof sol.TryStatement) {
            res = this.execTryStatement(stmt, state);
        } else if (stmt instanceof sol.RevertStatement) {
            res = this.execRevertStatement(stmt, state);
        } else if (stmt instanceof sol.Throw) {
            res = this.execThrow(stmt, state);
            /*
        } else if (stmt instanceof sol.EmitStatement) {
            res = this.execEmitStatement(stmt, state);
        } else if (stmt instanceof sol.InlineAssembly) {
            res = this.execInlineAssembly(stmt, state);
            */
        } else {
            nyi(`Stmt ${stmt.constructor.name}`);
        }

        for (const v of this.visitors) {
            v.exec(this, state, stmt);
        }

        this.nodes.pop();

        return res;
    }

    private execRevertStatement(stmt: sol.RevertStatement, state: State): ControlFlow {
        const errorDef = stmt.errorCall.vReferencedDeclaration;
        this.expect(errorDef instanceof sol.ErrorDefinition);

        const self = this;
        const selector = hexToBytes(`0x${this._infer.signatureHash(errorDef)}`);
        const argTs = errorDef.vParameters.vParameters.map((d) =>
            changeLocTo(self.varDeclToRuntimeType(d), sol.DataLocation.Memory)
        );
        const argVs = stmt.errorCall.vArguments.map((arg) => this.eval(arg, state));
        const ts = this.pushTempScope(argTs, state);
        this.assign(ts.temps, argVs, state);
        const argData = encode(ts.tempVals, argTs, state);
        this.popScope(state);
        this.expect(argData instanceof Uint8Array);
        const data = concatBytes(selector, argData);
        const msg = `${errorDef.name}(${argVs.map(ppValue).join(", ")})`;
        this.runtimeError(CustomError, state, msg, data);
    }

    private execThrow(stmt: sol.Throw, state: State): ControlFlow {
        this._execCall(revertBuiltin, [], [], state);
        this.expect(false); // Never reached
    }

    private matchTryClause(
        data: Uint8Array,
        clause: sol.TryCatchClause,
        state: State
    ): Value[] | undefined {
        if (clause.errorName === "Panic") {
            return decodesWithSelector(PANIC_SELECTOR, data, [rtt.uint256], state);
        }

        if (clause.errorName === "Error") {
            return decodesWithSelector(ERROR_SELECTOR, data, [memStringT], state);
        }

        if (clause.errorName === "") {
            let argTs: BaseInterpType[];

            if (clause.vParameters !== undefined) {
                this.expect(clause.vParameters.vParameters.length <= 1);
                const self = this;
                argTs = clause.vParameters.vParameters.map((d) => self.varDeclToRuntimeType(d));
                this.expect(argTs.length === 0 || argTs[0].pp() === "bytes memory");
            } else {
                argTs = [];
            }

            if (argTs.length === 0) {
                return [];
            }

            const memBytesView = rtt.PointerMemView.allocMemFor(data, bytesT, state.memAllocator);

            memBytesView.encode(data, state.memory, state.memAllocator);

            return [memBytesView];
        }

        nyi(`Error clause ${clause.errorName}`);
    }

    private execTryStatement(stmt: sol.TryStatement, state: State): ControlFlow {
        const callee = this.evalNP(stmt.vExternalCall.vExpression, state);
        this.expect(
            callee instanceof NewCall ||
            callee instanceof rtt.ExternalFunRef ||
            callee instanceof ExternalCallDescription
        );
        const res = this._evalMsgCall(stmt.vExternalCall, liftExtCalRef(callee), state);

        const actualCallee = callee instanceof ExternalCallDescription ? callee.target : callee;
        this.expect(
            actualCallee instanceof NewCall || actualCallee instanceof rtt.ExternalFunRef,
            `Unexpected call target in try statement ${ppValue(callee)}`
        );
        this.expect(stmt.vClauses.length >= 2);

        // Success case. Parse out the return values
        if (!res.reverted) {
            let vals: Value[];

            if (actualCallee instanceof rtt.ExternalFunRef) {
                const target = stmt.vExternalCall.vReferencedDeclaration;
                this.expect(
                    target instanceof sol.FunctionDefinition ||
                    target instanceof sol.VariableDeclaration,
                    `NYI external call target`
                );
                vals = this.getValuesFromReturnedCalldata(res.data, target, state);
            } else {
                this.expect(res.newContract !== undefined);
                vals = [res.newContract];
            }

            return this.execTryCatchClause(stmt.vClauses[0], vals, state);
        }

        // First try any Panic/Error clauses
        const namedClauses = stmt.vClauses.filter((c) => c.errorName !== "");
        for (const clause of namedClauses) {
            const vals = this.matchTryClause(res.data, clause, state);

            if (vals !== undefined) {
                return this.execTryCatchClause(clause, vals, state);
            }
        }

        const lowLevelClauses = stmt.vClauses.slice(1).filter((c) => c.errorName === "");
        this.expect(lowLevelClauses.length <= 1);

        if (lowLevelClauses.length == 1) {
            const vals = this.matchTryClause(res.data, lowLevelClauses[0], state);
            this.expect(vals !== undefined);
            return this.execTryCatchClause(lowLevelClauses[0], vals, state);
        }

        this.runtimeError(RuntimeError, state, "", res.data);
    }

    private execTryCatchClause(
        clause: sol.TryCatchClause,
        args: Value[],
        state: State
    ): ControlFlow {
        if (clause.vParameters) {
            this.pushScope(
                clause,
                rtt.zip(
                    clause.vParameters.vParameters.map((d) => d.name),
                    args
                ),
                state
            );
        } else {
            this.pushScope(clause, [], state);
        }

        const flow = this.exec(clause.vBlock, state);

        this.popScope(state);
        return flow;
    }

    private execVariableDeclarationStatement(
        stmt: sol.VariableDeclarationStatement,
        state: State
    ): ControlFlow {
        let varInitialVals: Value[] = [];
        if (stmt.vInitialValue) {
            const initVal = this.evalNP(stmt.vInitialValue, state);

            varInitialVals = stmt.assignments.length > 1 ? (initVal as Value[]) : [initVal];
        } else {
            varInitialVals = stmt.vDeclarations.map((d) => {
                const type = this.varDeclToRuntimeType(d);
                return makeZeroValue(type, state);
            });
        }

        // VariableDeclarationStatements are their own scope on solidity >0.5.0 and
        // when they are in the initialization of a for loop.
        if (gte(this.compilerVersion, "0.5.0") || stmt.parent instanceof sol.ForStatement) {
            this.pushScope(
                stmt,
                stmt.vDeclarations.map((d) => [d.name, none]),
                state
            );
        }

        sol.assert(state.scope !== undefined, `Missing scope`);
        for (let i = 0, j = 0; i < stmt.assignments.length; i++) {
            if (stmt.assignments[i] === null) {
                continue;
            }

            const loc = state.scope.lookupLocation(stmt.vDeclarations[j].name);

            if (loc === undefined) {
                this.fail(NotDefined, ``);
            }

            this.assign(loc, varInitialVals[i], state);
            j++;
        }

        return ControlFlow.Fallthrough;
    }

    private execExpressionStatement(stmt: sol.ExpressionStatement, state: State): ControlFlow {
        // I think (?) the only things that can break control flow are statements (break, continue, return)
        // Note that exceptions (revert, assert...) are also handled in the interpreter by raising an exception and handling
        // it at the last external call site
        this.eval(stmt.vExpression, state);
        return ControlFlow.Fallthrough;
    }

    private execBlock(block: sol.Block | sol.UncheckedBlock, state: State): ControlFlow {
        let flow: ControlFlow = ControlFlow.Fallthrough;

        const localVals: Array<[string, Value]> = [];

        // For Solidity <0.5.0 block locals are live for the whole block. So 0-init them at the start of the block
        if (lt(this.compilerVersion, "0.5.0")) {
            for (const stmt of block.vStatements) {
                if (stmt instanceof sol.VariableDeclarationStatement) {
                    for (const decl of stmt.vDeclarations) {
                        const type = this.varDeclToRuntimeType(decl);
                        localVals.push([decl.name, makeZeroValue(type, state)]);
                    }
                }
            }
        }

        this.pushScope(block, localVals, state);

        for (const stmt of block.vStatements) {
            flow = this.exec(stmt, state);

            if (flow !== ControlFlow.Fallthrough) {
                break;
            }
        }

        if (gte(this.compilerVersion, "0.5.0")) {
            // In Solidity >0.5.0 all variable declaration statements in the block are their own scopes, that go out of scope at the end
            // of the block. So remove them here
            while (!(state.scope instanceof LocalsScope && state.scope.node === block)) {
                this.popScope(state);
            }
        }

        this.popScope(state);
        return flow;
    }

    private execReturn(stmt: sol.Return, state: State): ControlFlow {
        sol.assert(state.scope !== undefined, ``);
        let retVals: Value[] = [];

        if (stmt.vExpression) {
            const retVal = this.evalNP(stmt.vExpression, state);
            const retExprT = this.typeOf(stmt.vExpression);
            retVals = retExprT instanceof rtt.TupleType ? (retVal as Value[]) : [retVal];
        } else {
            retVals = [];
        }

        const frame = stackTop(state.intCallStack);
        const fun = frame.callee;
        this.expect(
            fun instanceof sol.FunctionDefinition,
            `Unexpected return outside of a function call`
        );

        sol.assert(
            retVals.length === fun.vReturnParameters.vParameters.length || retVals.length === 0,
            `Mismatch in number of ret vals and formal returns`
        );

        for (let i = 0; i < retVals.length; i++) {
            const ret = frame.scope._lookupLocation(
                LocalsScope.returnName(fun?.vReturnParameters.vParameters[i], i)
            );
            this.expect(ret !== undefined);
            this.assign(ret, retVals[i], state);
        }

        return ControlFlow.Return;
    }

    private execIfStatement(stmt: sol.IfStatement, state: State): ControlFlow {
        const condV = this.evalT(stmt.vCondition, Boolean, state);
        let cflow: ControlFlow = ControlFlow.Fallthrough;

        if (condV) {
            cflow = this.exec(stmt.vTrueBody, state);
        } else if (stmt.vFalseBody) {
            cflow = this.exec(stmt.vFalseBody, state);
        }

        return cflow;
    }

    private execWhileStatement(stmt: sol.WhileStatement, state: State): ControlFlow {
        // @todo: In the evm gas prevents us from infinite loops. Should we add some sort of loop limit here as well to avoid infinte loops?
        while (true) {
            const condVal = this.evalT(stmt.vCondition, Boolean, state);

            if (!condVal) {
                break;
            }

            const bodyCflow = this.exec(stmt.vBody, state);

            if (bodyCflow === ControlFlow.Return) {
                return ControlFlow.Return;
            }

            if (bodyCflow === ControlFlow.Break) {
                break;
            }

            // Nothing to do on continue.
        }

        return ControlFlow.Fallthrough;
    }

    private execBreak(): ControlFlow {
        return ControlFlow.Break;
    }

    private execContinue(): ControlFlow {
        return ControlFlow.Continue;
    }

    private execDoWhileStatement(stmt: sol.DoWhileStatement, state: State): ControlFlow {
        let cond: boolean;

        // @todo: In the evm gas prevents us from infinite loops. Should we add some sort of loop limit here as well to avoid infinte loops?
        do {
            // Execute body first
            const bodyCflow = this.exec(stmt.vBody, state);

            if (bodyCflow === ControlFlow.Return) {
                return ControlFlow.Return;
            }

            if (bodyCflow === ControlFlow.Break) {
                break;
            }

            cond = this.evalT(stmt.vCondition, Boolean, state);
        } while (cond);

        return ControlFlow.Fallthrough;
    }

    private execForStatement(stmt: sol.ForStatement, state: State): ControlFlow {
        if (stmt.vInitializationExpression !== undefined) {
            const initFlow = this.exec(stmt.vInitializationExpression, state);
            this.expect(initFlow === ControlFlow.Fallthrough);
        }

        while (true) {
            let cond: boolean;

            if (stmt.vCondition) {
                cond = this.evalT(stmt.vCondition, Boolean, state);
            } else {
                cond = true;
            }

            if (!cond) {
                break;
            }

            const bodyCflow = this.exec(stmt.vBody, state);

            if (bodyCflow === ControlFlow.Return) {
                return ControlFlow.Return;
            }

            if (bodyCflow === ControlFlow.Break) {
                break;
            }

            // Eval the loop expression
            if (stmt.vLoopExpression !== undefined) {
                const loopFlow = this.exec(stmt.vLoopExpression, state);
                this.expect(loopFlow === ControlFlow.Fallthrough);
            }
        }

        // We added a scope for the for loop initialization statement. Pop it here.
        if (
            state.scope instanceof LocalsScope &&
            state.scope.node === stmt.vInitializationExpression
        ) {
            this.popScope(state);
        }

        return ControlFlow.Fallthrough;
    }

    private execPlaceholderStatement(stmt: sol.PlaceholderStatement, state: State): ControlFlow {
        const frame = stackTop(state.intCallStack);

        this.expect(
            frame.callee instanceof sol.FunctionDefinition && frame.curModifier !== undefined
        );

        const curMod = frame.curModifier;
        const mods = getModifiers(frame.callee);

        const modIdx = mods.indexOf(curMod);
        this.expect(modIdx >= 0);

        // Execute the next modifier
        if (modIdx < mods.length - 1) {
            const nextMod = mods[modIdx + 1];
            // Eval the modifier args in the modified function's syntactic scope
            const savedScope = state.scope;

            state.scope = frame.scope;
            const modArgs = nextMod.vArguments.map((argE) => this.eval(argE, state));

            // This is wrong - this should be the formal argument of the next modifier
            const modArgTs = nextMod.vArguments.map((argE) => this.typeOf(argE));
            state.scope = savedScope;

            this._execCall(nextMod, modArgs, modArgTs, state);
            return ControlFlow.Fallthrough;
        }

        // Execute the function body
        const body = frame.callee.vBody;

        this.expect(body !== undefined, `Can't execute function ${frame.callee.name} with no body`);
        const savedScope = state.scope;
        state.scope = frame.scope;
        const savedCurModifier = frame.curModifier;

        const flow = this.exec(body, state);
        this.expect(flow === ControlFlow.Fallthrough || flow === ControlFlow.Return);

        state.scope = savedScope;
        frame.curModifier = savedCurModifier;

        // Note that even if the underyling function has a `Return` control flow, execution continues after the placeholder
        return ControlFlow.Fallthrough;
    }

    ///*********************EXPRESSIONS************************************************
    /**
     * Evaluate a single expression in a given state. Return a trace of the
     * evaluation and the resulting value.
     */
    public eval(expr: sol.Expression, state: State): Value {
        this.nodes.push(expr);
        let res: Value;

        if (expr instanceof sol.Assignment) {
            res = this.evalAssignment(expr, state);
        } else if (expr instanceof sol.BinaryOperation) {
            res = this.evalBinaryOperation(expr, state);
        } else if (expr instanceof sol.Conditional) {
            res = this.evalConditional(expr, state);
        } else if (expr instanceof sol.FunctionCall) {
            res = this.evalFunctionCall(expr, state);
        } else if (expr instanceof sol.FunctionCallOptions) {
            res = this.evalFunctionCallOptions(expr, state);
        } else if (expr instanceof sol.NewExpression) {
            res = this.evalNewExpression(expr);
        } else if (expr instanceof sol.Identifier) {
            res = this.evalIdentifier(expr, state);
        } else if (expr instanceof sol.IndexAccess) {
            res = this.evalIndexAccess(expr, state);
        } else if (expr instanceof sol.IndexRangeAccess) {
            res = this.evalIndexRangeAccess(expr, state);
        } else if (expr instanceof sol.Literal) {
            res = this.evalLiteral(expr, state);
        } else if (expr instanceof sol.MemberAccess) {
            res = this.evalMemberAccess(expr, state);
        } else if (expr instanceof sol.TupleExpression) {
            res = this.evalTupleExpression(expr, state);
        } else if (expr instanceof sol.UnaryOperation) {
            res = this.evalUnaryOperation(expr, state);
        } else if (expr instanceof sol.ElementaryTypeNameExpression) {
            res = none;
        } else {
            nyi(`evalExpression(${expr.constructor.name})`);
        }

        // console.error(`eval(${printNode(expr)})->${ppValue(res)}`)
        for (const v of this.visitors) {
            v.eval(this, state, expr, res);
        }

        this.nodes.pop();

        return res;
    }

    /**
     * Evaluate an expression in a given state, and check that its of a particular expected value type.
     */
    evalT<T extends ValueTypeConstructors>(
        expr: sol.Expression,
        typeConstr: T,
        state: State
    ): TypeConstructorToValueType<T> {
        const res = this.eval(expr, state);

        if (!match(res, typeConstr)) {
            this.fail(
                InternalError,
                `Unexpected eval result ${ppValue(res)}. Expected ${ppValueTypeConstructor(typeConstr)}`
            );
        }

        return res;
    }

    /**
     * Evaluate an expression in a given state, and check that result is not poison
     */
    public evalNP(expr: sol.Expression, state: State): NonPoisonValue {
        const res = this.eval(expr, state);

        if (res instanceof Poison) {
            this.fail(InternalError, `Got poison`, expr);
        }

        return res;
    }

    evalLV(expr: sol.Expression, state: State): LValue {
        this.nodes.push(expr);
        let res: LValue;

        if (expr instanceof sol.Identifier) {
            sol.assert(state.scope !== undefined, `Missing scope in evalLV({0})`, expr);
            const scopeView = state.scope.lookupLocation(expr.name);
            if (scopeView === undefined) {
                this.fail(NotDefined, ``);
            }

            return scopeView;
        } else if (expr instanceof sol.TupleExpression) {
            const lvs: LValue[] = [];
            for (const comp of expr.vOriginalComponents) {
                if (comp === null) {
                    lvs.push(null);
                    continue;
                }

                lvs.push(this.evalLV(comp, state));
            }

            res = lvs.length === 1 ? lvs[0] : lvs;
        } else if (expr instanceof sol.IndexAccess) {
            this.expect(
                expr.vIndexExpression !== undefined,
                `Missing index expression in ${expr.print()}`
            );

            let baseLV = this.evalLV(expr.vBaseExpression, state);
            // Note that the index expression of an LValue is not itself an LValue so we eval it.
            const indexVal = this.evalNP(expr.vIndexExpression, state);

            this.expect(
                baseLV instanceof View,
                `Expected IndexAccess LValue ${expr.print()} to evaluate to a view, not ${baseLV}`
            );

            if (isPointerView(baseLV)) {
                baseLV = deref(baseLV, state);
            }

            let idxView: LValue | DecodingFailure;

            if (isArrayLikeView(baseLV)) {
                this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);

                if (isArrayLikeMemView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, state.memory);
                } else if (isArrayLikeCalldataView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, getMsg(state));
                } else if (isArrayLikeStorageView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, getStateStorage(state));
                } else if (baseLV instanceof ArrayLikeLocalView) {
                    idxView = baseLV.indexView(indexVal);
                } else {
                    nyi(`Unkown ArrayLikeView ${baseLV.constructor.name}`);
                }
            } else if (baseLV instanceof MapStorageView) {
                const key =
                    indexVal instanceof View
                        ? decodeView(indexVal, state)
                        : (indexVal as PrimitiveValue);
                idxView = baseLV.indexView(key);
            } else {
                nyi(`Index access base ${ppLValue(baseLV)}`);
            }

            if (idxView instanceof DecodingFailure) {
                this.runtimeError(OOBError, state);
            }

            res = idxView;
        } else if (expr instanceof sol.MemberAccess) {
            let baseLV = this.evalLV(expr.vExpression, state);
            this.expect(
                baseLV instanceof View,
                `Expected IndexAccess LValue ${expr.print()} to evaluate to a view, not ${baseLV}`
            );

            if (isPointerView(baseLV)) {
                baseLV = deref(baseLV, state);
            }

            if (isStructView(baseLV)) {
                const fieldView = baseLV.fieldView(expr.memberName);
                this.expect(
                    fieldView instanceof View,
                    `No field ${expr.memberName} found on base ${baseLV.pp()}`
                );

                res = fieldView;
            } else if (baseLV instanceof rtt.ArrayStorageView && expr.memberName === "length") {
                // Assinging to storage array lengths changes their length
                // @todo (dimo) do we zero-out elements when we truncate the length?
                // @todo (dimo) support assinging to bytes.length
                res = rtt.makeStorageView(rtt.uint256, [baseLV.key, baseLV.endOffsetInWord]);
            } else {
                nyi(`evalLV(${printNode(expr)}): ${ppLValue(baseLV)}`);
            }
        } else {
            nyi(`evalLV(${expr.print()})`);
        }

        for (const v of this.visitors) {
            v.eval(this, state, expr, res);
        }

        this.nodes.pop();

        return res;
    }

    private implicitCoercionImpl(
        value: rtt.PrimitiveValue,
        toType: rtt.BaseRuntimeType,
        state: State
    ): PrimitiveValue | undefined {
        // fixed bytes -> bigger fixed bytes
        if (value instanceof Uint8Array && toType instanceof rtt.FixedBytesType && value.length < toType.numBytes) {
            return setLengthRight(value, toType.numBytes)
        }

        // fixed bytes -> smaller fixed bytes not allowed implicitly
        if (value instanceof Uint8Array && toType instanceof rtt.FixedBytesType && value.length > toType.numBytes) {
            return undefined
        }

        // No Coercion
        if (
            (typeof value === "bigint" && toType instanceof rtt.IntType) ||
            (typeof value === "boolean" && toType instanceof rtt.BoolType) ||
            (value instanceof Uint8Array && toType instanceof rtt.FixedBytesType) ||
            (value instanceof Address && toType instanceof rtt.AddressType) ||
            ((value instanceof rtt.InternalFunRef ||
                value instanceof rtt.ExternalFunRef ||
                value instanceof NewCall ||
                value instanceof ExternalCallDescription) &&
                toType instanceof rtt.FunctionType) ||
            (value instanceof View && isDirectlyAssignable(toType, typeOfView(value))) ||
            value instanceof TypeTuple ||
            value instanceof Poison // Local/return variables are initialized to None at scope creation
        ) {
            return value;
        }

        // string -> bytes cast in memory/storage
        if (
            value instanceof View &&
            value.type instanceof rtt.StringType &&
            toType instanceof rtt.PointerType &&
            toType.toType instanceof rtt.BytesType
        ) {
            this.expect(
                value instanceof StringMemView ||
                value instanceof rtt.StringCalldataView ||
                value instanceof rtt.StringSliceCalldataView
            );
            return castStringToBytes(value);
        }

        // bytes -> string cast in memory
        if (
            value instanceof View &&
            value.type instanceof rtt.BytesType &&
            toType instanceof rtt.PointerType &&
            toType.toType instanceof rtt.StringType
        ) {
            if (value instanceof BytesMemView) {
                return new StringMemView(stringT, value.offset);
            }
        }

        // Int literals to fixed byte
        if (typeof value === "bigint" && toType instanceof rtt.FixedBytesType) {
            const view = makeMemoryView(value < 0n ? int256 : rtt.uint256, 0n);
            view.encode(value, scratchWord, undefined as unknown as any);

            return scratchWord.slice(32 - toType.numBytes);
        }

        // ints to address
        if (typeof value === "bigint" && toType instanceof rtt.AddressType) {
            return new Address(setLengthLeft(bigIntToBytes(value), 20));
        }

        // bytes memory literals to fixed bytes
        if (value instanceof BytesMemView && toType instanceof rtt.FixedBytesType) {
            const t = decodeView(value, state) as Uint8Array;
            if (t.length > toType.numBytes) {
                return undefined;
            }

            return setLengthRight(t, toType.numBytes);
        }

        // string memory literals to fixed bytes
        if (value instanceof StringMemView && toType instanceof rtt.FixedBytesType) {
            const t = decodeView(castStringToBytes(value), state) as Uint8Array;
            if (t.length > toType.numBytes) {
                return undefined;
            }

            return setLengthRight(t, toType.numBytes);
        }

        return undefined;
    }

    private implicitCoercion(
        rvalue: rtt.PrimitiveValue,
        lvType: rtt.BaseRuntimeType,
        state: State
    ): PrimitiveValue {
        const res = this.implicitCoercionImpl(rvalue, lvType, state);
        this.expect(
            res !== undefined,
            `NYI Implicit coercion from ${ppValue(rvalue)} to type ${lvType.pp()}`
        );
        return res;
    }

    public assign(lvalue: LValue, rvalue: Value, state: State): void {
        // Handle tuple assignments first
        if (lvalue instanceof Array) {
            this.expect(
                rvalue instanceof Array && rvalue.length === lvalue.length,
                `Mismatch in tuple assignment`
            );

            for (let i = 0; i < lvalue.length; i++) {
                this.assign(lvalue[i], rvalue[i], state);
            }
            return;
        }

        if (lvalue === null) {
            // Nothing to do
            // This happens when we have tuple assignment where there are missing lvalue components
            return;
        }

        // console.error(`Assigning ${ppValue(rvalue)}->${ppLValue(lvalue)} of type ${lvalue.type.pp()}`)
        this.expect(
            isPrimitiveValue(rvalue),
            `Unexpected rvalue ${ppValue(rvalue)} in assignment to ${ppLValue(lvalue)}`
        );

        // Special case - assigning to bytes length in storage requires decoding and re-encoding
        // due to the compressed way length is handled in storage
        if (lvalue instanceof BytesStorageLength) {
            rvalue = this.implicitCoercion(rvalue, rtt.uint256, state) as bigint;

            let bytes = decodeView(lvalue.view, state) as Uint8Array;
            bytes = setLengthRight(bytes, bigIntToNum(rvalue));
            setStateStorage(state, lvalue.view.encode(bytes, getStateStorage(state)));
            return;
        }

        rvalue = this.implicitCoercion(rvalue, lvalue.type, state);

        // The following ref-type assignments result in a copy of the underlying complex value
        // - storage-to-storage
        // - memory-to-storage
        // - storage-to-memory
        // - calldata-to-memory
        // - calldata-to-storage
        if (
            (lvalue instanceof BaseStorageView && rvalue instanceof BaseStorageView) ||
            (lvalue instanceof BaseStorageView && rvalue instanceof BaseMemoryView) ||
            (lvalue instanceof BaseMemoryView && rvalue instanceof BaseStorageView) ||
            (lvalue instanceof BaseMemoryView && rvalue instanceof BaseCalldataView) ||
            (lvalue instanceof BaseStorageView && rvalue instanceof BaseCalldataView) ||
            (lvalue instanceof PointerLocalView &&
                lvalue.type.location === sol.DataLocation.Memory &&
                (rvalue instanceof BaseStorageView || rvalue instanceof BaseCalldataView))
        ) {
            // Types should be equal modulo location
            this.expect(
                isDirectlyAssignable(lvalue.type, typeOfView(rvalue)),
                `Mismatching types in copying ref assignment (modulo location): ${lvalue.type.pp()} and ${rvalue.type.pp()} `
            );

            const complexRVal = decodeView(rvalue, state);

            if (lvalue instanceof BaseMemoryView) {
                lvalue.encode(complexRVal, state.memory, state.memAllocator);
            } else if (lvalue instanceof BaseStorageView) {
                setStateStorage(state, lvalue.encode(complexRVal, getStateStorage(state)));
            } else {
                const memView = PointerMemView.allocMemFor(
                    complexRVal,
                    lvalue.type.toType,
                    state.memAllocator
                );
                memView.encode(complexRVal, state.memory, state.memAllocator);
                lvalue.encode(memView);
            }

            return;
        }

        if (typeof rvalue === "bigint" && lvalue.type instanceof rtt.FixedBytesType) {
            rvalue = bigIntToBytes(rvalue);
        }

        // In all other cases we are either:
        // 1. assigning a primitive value,
        // 2. assigning memory-to-memory (which aliases),
        // 3. assigning to a local pointer a reference of the same type (which aliases)
        if (lvalue instanceof BaseStorageView) {
            setStateStorage(state, lvalue.encode(rvalue, getStateStorage(state)));
        } else if (lvalue instanceof BaseMemoryView) {
            lvalue.encode(rvalue, state.memory, state.memAllocator);
        } else if (lvalue instanceof BaseLocalView) {
            this.expect(
                !(lvalue.type instanceof sol.PointerType) ||
                isPoison(rvalue as rtt.PrimitiveValue) ||
                (rvalue instanceof View && lvalue.type.to.pp() === rvalue.type.pp()),
                `Unexpected assignment of ${ppValue(rvalue)} to local of type ${lvalue.type.pp()}`
            );
            lvalue.encode(rvalue);
        } else if (lvalue === null) {
            // Nothing to do - missing component in the LHS of a tuple assignment.
        } else {
            nyi(`assign(${lvalue}, ${rvalue}, ${state})`);
        }
    }

    evalAssignment(expr: sol.Assignment, state: State): Value {
        let rvalue = this.evalNP(expr.vRightHandSide, state);
        const lv = this.evalLV(expr.vLeftHandSide, state);

        // @todo after indexaccess is fixed, add a test of the shape a[i++] = i++; and (a[i++], a[i++]) = [1,2]; to see order of evaluation.

        // Assignment with a combined binary operator
        if (expr.operator.length > 1) {
            const op = expr.operator.slice(0, -1);
            const lVal = this.lvToValue(lv, state);
            const lType = this.typeOf(expr.vLeftHandSide);
            const rType = this.typeOf(expr.vRightHandSide);
            // @todo Need to detect userdefined function manually here! The AST doesn't give us a this like a BinaryOperation would

            rvalue = this.computeBinary(
                lVal,
                lType,
                op,
                rvalue,
                rType,
                lType,
                undefined,
                this.isUnchecked(expr),
                state
            );
            this.assign(lv, rvalue, state);
        } else {
            this.assign(lv, rvalue, state);
        }

        // @todo do we return lvalue or rvalue here?
        return rvalue;
    }

    private clamp(
        val: bigint,
        type: rtt.BaseRuntimeType,
        unchecked: boolean,
        state: State
    ): bigint {
        const clampedVal = type instanceof rtt.IntType ? clampIntToType(val, type) : val;
        const overflow = clampedVal !== val;

        if (overflow && !unchecked) {
            this.runtimeError(OverflowError, state);
        }

        return clampedVal;
    }

    /*
    private coerceIntLiteralsToBytes(left: Value, right: Value): [Value, Value] {
        if (typeof left === typeof right) {
            return [left, right];
        }

        if (typeof left === "bigint" && right instanceof Uint8Array) {
            const t = left;
            left = right;
            right = t;
        }

        if (left instanceof Uint8Array && typeof right === "bigint") {
            right = bigIntToBytes(right);
            const len = left.length > right.length ? left.length : right.length;

            left = setLengthLeft(left, len);
            right = setLengthLeft(right, len);

            return [left, right];
        }

        this.fail(InterpError, `Unexpected values ${ppValue(left)} and ${ppValue(right)}`);
    }
        */

    private coerceToSameType(
        left: PrimitiveValue,
        lType: BaseInterpType,
        right: PrimitiveValue,
        rType: BaseInterpType,
        state: State
    ): [PrimitiveValue, PrimitiveValue] {
        if (lType.pp() == rType.pp()) {
            return [left, right];
        }

        const castRigth = this.implicitCoercionImpl(right, lType, state);

        if (castRigth !== undefined) {
            return [left, castRigth];
        }

        const castLeft = this.implicitCoercionImpl(left, rType, state);

        if (castLeft !== undefined) {
            return [castLeft, right];
        }

        nyi(
            `Cannot cast ${ppValue(left)} of type ${lType.pp()} and ${ppValue(right)} of type ${rType.pp()} to same type`
        );
    }

    private computeBinary(
        left: Value,
        lType: BaseInterpType,
        operator: string,
        right: Value,
        rType: BaseInterpType,
        expType: BaseInterpType,
        userFunction: sol.FunctionDefinition | undefined,
        unchecked: boolean,
        state: State
    ): NonPoisonValue {
        // @todo - need to detect
        if (userFunction) {
            nyi("User-defined operators");
        }

        this.expect(isPrimitiveValue(left) && isPrimitiveValue(right));

        if (sol.BINARY_OPERATOR_GROUPS.Logical.includes(operator)) {
            this.expect(typeof left === "boolean" && typeof right === "boolean");

            if (operator === "&&") {
                return left && right;
            }

            if (operator === "||") {
                return left || right;
            }

            nyi(`Unknown logical operator ${operator}`);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Equality.includes(operator)) {
            let isEqual: boolean;

            [left, right] = this.coerceToSameType(left, lType, right, rType, state);

            if (typeof left === "boolean" && typeof right === "boolean") {
                isEqual = left === right;
            } else if (typeof left === "bigint" && typeof right === "bigint") {
                isEqual = left === right;
            } else if (left instanceof Uint8Array && right instanceof Uint8Array) {
                isEqual = equalsBytes(left, right);
            } else if (left instanceof Address && right instanceof Address) {
                isEqual = left.equals(right);
            } else {
                nyi(
                    `${left}(${left.constructor.name}) <${lType.pp()}> ${operator} ${right}(${right.constructor.name}) <${rType.pp()}>`
                );
            }

            if (operator === "==") {
                return isEqual;
            }

            if (operator === "!=") {
                return !isEqual;
            }

            fail(`Unknown equality operator ${operator}`);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Comparison.includes(operator)) {
            let [sleft, sright]: [any, any] = this.coerceToSameType(
                left,
                lType,
                right,
                rType,
                state
            );

            if (sleft instanceof Address && sright instanceof Address) {
                sleft = sleft.toString();
                sright = sright.toString();
            }

            if (sleft instanceof Uint8Array && sright instanceof Uint8Array) {
                // Perform lexicographical comparison
                sleft = bytesToHex(sleft);
                sright = bytesToHex(sright);
            }

            this.expect(
                (typeof sleft === "bigint" && typeof sright === "bigint") ||
                (typeof sleft === "string" && typeof sright === "string")
            );

            if (operator === "<") {
                return sleft < sright;
            }

            if (operator === "<=") {
                return sleft <= sright;
            }

            if (operator === ">") {
                return sleft > sright;
            }

            if (operator === ">=") {
                return sleft >= sright;
            }

            nyi(`Unknown comparison operator ${operator}`);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Arithmetic.includes(operator)) {
            this.expect(typeof left === "bigint" && typeof right === "bigint");
            let res: bigint;

            if ((operator === "/" || operator === "%") && right === 0n) {
                this.runtimeError(PanicError, state, 0x12n);
            }

            if (operator === "+") {
                res = left + right;
            } else if (operator === "-") {
                res = left - right;
            } else if (operator === "*") {
                res = left * right;
            } else if (operator === "/") {
                res = left / right;
            } else if (operator === "%") {
                res = left % right;
            } else if (operator === "**") {
                res = left ** right;
            } else {
                nyi(`Unknown arithmetic operator ${operator}`);
            }

            return this.clamp(res, expType, unchecked, state);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Bitwise.includes(operator)) {
            if (operator === "<<" || operator === ">>") {
                this.expect(typeof right === "bigint");

                if (typeof left === "bigint") {
                    return operator === "<<" ? left << right : left >> right;
                }

                this.expect(left instanceof Uint8Array);
                nyi(`Bitshift of fixed bytes`);
            }

            if (typeof left === "bigint" && typeof right === "bigint") {
                if (operator === "|") {
                    return left | right;
                }

                if (operator === "&") {
                    return left & right;
                }

                if (operator === "^") {
                    return left ^ right;
                }

                nyi(`Unknown bitwise operator ${operator}`);
            }

            nyi(`Bitwise ${operator} on fixed bytes`);
        }

        nyi(`${left} ${operator} ${right}`);
    }

    evalBinaryOperation(expr: sol.BinaryOperation, state: State): Value {
        // Eval constant expression as one whole block, as those are evaluated at compile time.
        if (sol.isConstant(expr)) {
            return solcValueToValue(sol.evalBinary(expr, this._infer));
        }

        // Note: RHS evaluates first.
        const rVal = this.evalNP(expr.vRightExpression, state);
        const lVal = this.evalNP(expr.vLeftExpression, state);

        return this.computeBinary(
            lVal,
            this.typeOf(expr.vLeftExpression),
            expr.operator,
            rVal,
            this.typeOf(expr.vRightExpression),
            this.typeOf(expr),
            expr.vUserFunction,
            this.isUnchecked(expr),
            state
        );
    }

    evalConditional(expr: sol.Conditional, state: State): Value {
        const cVal = this.evalT(expr.vCondition, Boolean, state);

        return this.eval(cVal ? expr.vTrueExpression : expr.vFalseExpression, state);
    }

    evalTypeExpression(expr: sol.Expression, state: State, loc?: sol.DataLocation): BaseTypeValue {
        if (expr instanceof sol.ElementaryTypeNameExpression) {
            const type = this.astToRuntimeType(
                this._infer.typeOfElementaryTypeNameExpression(expr).type,
                loc
            );
            return new TypeValue(type);
        }

        if (expr instanceof sol.TupleExpression) {
            return new TypeTuple(
                expr.vOriginalComponents.map((c) =>
                    this.evalTypeExpression(c as sol.Expression, state, loc)
                )
            );
        }

        if (expr instanceof sol.IndexAccess) {
            const innerT = this.evalTypeExpression(expr.vBaseExpression, state, loc);
            let size: bigint | undefined;

            if (expr.vIndexExpression !== undefined) {
                const sizeVal = this.eval(expr.vIndexExpression, state);
                this.expect(typeof sizeVal === "bigint");
                size = sizeVal;
            }

            this.expect(innerT instanceof TypeValue);
            return new TypeValue(new rtt.ArrayType(innerT.type, size));
        }

        if (expr instanceof sol.Identifier || expr instanceof sol.MemberAccess) {
            const exprT = this.typeOf(expr);
            this.expect(exprT instanceof rtt.TypeType, ``);
            return new TypeValue(this.astToRuntimeType(exprT.rawT, loc));
        }

        nyi(`evalTypeExpression(${expr.constructor.name})`);
    }

    /**
     * Type conversion is complex and changes with language versions.
     */
    evalTypeConversion(expr: sol.FunctionCall, toT: rtt.BaseRuntimeType, state: State): Value {
        this.expect(expr.vArguments.length === 1, `Type conversion expects a single argument`);
        const fromT = this.typeOf(expr.vArguments[0]);
        const fromV = this.evalNP(expr.vArguments[0], state);

        if (fromT.pp() === toT.pp()) {
            return fromV;
        }

        // int -> fixed bytes
        if (fromT instanceof rtt.IntType && toT instanceof rtt.FixedBytesType) {
            this.expect(typeof fromV === "bigint", `Expected a bigint`);
            scratchWord.fill(0);
            const view = new IntMemView(fromT, 0n);
            view.encode(fromV, scratchWord);

            return scratchWord.slice(32 - toT.numBytes, 32);
        }

        // fixed bytes -> int
        if (fromT instanceof rtt.FixedBytesType && toT instanceof rtt.IntType) {
            this.expect(fromV instanceof Uint8Array, `Expected bytes`);

            return bytesToIntOfType(fromV.slice(fromT.numBytes - toT.numBits / 8, fromT.numBytes), toT);
        }

        // string ptr -> bytes
        if (
            fromT instanceof rtt.PointerType &&
            fromT.toType instanceof rtt.StringType &&
            toT instanceof rtt.BytesType
        ) {
            this.expect(
                fromV instanceof StringMemView ||
                fromV instanceof rtt.StringCalldataView ||
                fromV instanceof rtt.StringSliceCalldataView ||
                fromV instanceof StringStorageView,
                `Expected string pointer not ${ppValue(fromV)}`
            );

            return castStringToBytes(fromV);
        }

        // string literals -> fixed bytes
        if (
            fromT instanceof rtt.PointerType &&
            fromT.toType instanceof rtt.StringType &&
            toT instanceof rtt.FixedBytesType
        ) {
            this.expect(
                fromV instanceof StringMemView ||
                fromV instanceof rtt.StringCalldataView ||
                fromV instanceof rtt.StringStorageView ||
                fromV instanceof rtt.StringSliceCalldataView,
                `Expected string pointer not ${ppValue(fromV)}`
            );

            const bytesView:
                | rtt.BytesCalldataView
                | BytesMemView
                | BytesStorageView
                | rtt.BytesSliceCalldataView = castStringToBytes(fromV);
            const bts = decodeView(bytesView, state);
            this.expect(bts instanceof Uint8Array && bts.length === toT.numBytes);
            return bts;
        }

        // int -> int
        if (fromT instanceof rtt.IntType && toT instanceof rtt.IntType) {
            this.expect(typeof fromV === "bigint");
            return clampIntToType(fromV, toT);
        }

        // fixed bytes -> address
        if (fromT instanceof rtt.FixedBytesType && toT instanceof rtt.AddressType) {
            this.expect(fromV instanceof Uint8Array);
            const addr = new Uint8Array(20);
            const off = fromT.numBytes - 20;
            addr.set(fromV.slice(off >= 0 ? off : 0));
            return new Address(addr);
        }

        // address -> fixed bytes
        if (
            fromT instanceof rtt.AddressType &&
            toT instanceof rtt.FixedBytesType &&
            toT.numBytes >= 20
        ) {
            this.expect(fromV instanceof Address);
            const res = new Uint8Array(toT.numBytes);
            res.set(fromV.bytes, toT.numBytes - 20);
            return res;
        }

        // int (literal) -> address
        if (fromT instanceof rtt.IntType && toT instanceof rtt.AddressType) {
            this.expect(typeof fromV === "bigint");
            const addr = new Uint8Array(20);
            rtt.encodeBigintInBigEndianBuf(fromV, addr, fromT.numBits / 8);
            return new Address(addr);
        }

        // library -> address
        if (
            fromT instanceof rtt.TypeType &&
            fromT.rawT instanceof sol.UserDefinedType &&
            fromT.rawT.definition instanceof sol.ContractDefinition &&
            fromT.rawT.definition.kind === sol.ContractKind.Library &&
            toT instanceof rtt.AddressType
        ) {
            return getLibraryLinkedAddress(fromT.rawT.definition, state);
        }

        // fixed bytes -> fixed bytes
        if (fromT instanceof rtt.FixedBytesType && toT instanceof rtt.FixedBytesType) {
            this.expect(fromV instanceof Uint8Array);
            if (fromT.numBytes < toT.numBytes) {
                return setLengthLeft(fromV, toT.numBytes);
            }

            return fromV.slice(0, toT.numBytes);
        }

        nyi(`evalTypeConversion ${fromT.pp()} -> ${toT.pp()}`);
    }

    detectStructFieldExprs(
        expr: sol.FunctionCall,
        struct: rtt.StructType
    ): Array<[string, sol.Expression]> {
        const res: Array<[string, sol.Expression]> = [];

        if (expr.fieldNames !== undefined) {
            this.expect(
                expr.fieldNames.length === expr.vArguments.length,
                `Mismatch in fieldNames and arguments`
            );
        }

        for (let i = 0, j = 0; i < expr.vArguments.length; i++) {
            let fieldName;

            if (expr.fieldNames !== undefined) {
                fieldName = expr.fieldNames[i];
            } else {
                let fieldT: BaseInterpType;

                do {
                    [fieldName, fieldT] = struct.fields[j++];
                } while (skipFieldDueToMap(fieldT));
            }

            res.push([fieldName, expr.vArguments[i]]);
        }

        return res;
    }

    /**
     * Evaluate a struct constructor call (e.g. Struct(5, x+y, [1,2,3])). This allocates memory to hold the struct,
     * evaluates all field expressions and assigns them to the relevant fiels in the memory struct.
     * Returns a view to the struct in memory.
     *
     * @param expr
     * @param state
     */
    evalStructConstructorCall(
        expr: sol.FunctionCall,
        structT: rtt.StructType,
        state: State
    ): Value {
        const structView = PointerMemView.allocMemFor(
            undefined,
            structT,
            state.memAllocator
        ) as StructMemView;

        const fieldExprs = this.detectStructFieldExprs(expr, structT);
        const fieldMap = new Map<string, Value>();

        // Note we must evalute the arguments in order to get the correct  trace
        for (const [fieldName, fieldExpr] of fieldExprs) {
            const argVal = this.evalNP(fieldExpr, state);
            fieldMap.set(fieldName, argVal);
        }

        for (const [fieldName, fieldT] of structView.type.fields) {
            if (skipFieldDueToMap(fieldT)) {
                continue;
            }

            const fieldView = structView.fieldView(fieldName);
            const fieldVal = fieldMap.get(fieldName);
            this.expect(
                fieldView instanceof BaseMemoryView,
                `Expected to get field ${fieldName} of ${structT.name}`
            );
            this.expect(
                fieldVal !== undefined,
                `Field ${fieldName} of ${structT.name} not found in constructor`
            );
            this.assign(fieldView, fieldVal, state);
        }

        return structView;
    }

    evalBuiltinCall(expr: sol.FunctionCall, callee: BuiltinFunction, state: State): Value {
        let args: Value[];
        let argTs: BaseInterpType[];
        const fun = callee;

        // `abi.decode` and `type()` are the only places where types appear as expresisons in the AST.
        // Handle those separately
        if (fun.name === "decode") {
            const bytes = this.evalNP(expr.vArguments[0], state);
            const types = this.evalTypeExpression(
                expr.vArguments[1],
                state,
                sol.DataLocation.Memory
            );

            args = [bytes, types];
            argTs = [memBytesT, typeValueToType(types)];
        } else if (fun.name === "type") {
            args = [this.evalTypeExpression(expr.vArguments[0], state)];
            argTs = [defT];
        } else if (fun.name === "encodeCall") {
            // encodeCall is a special case builtin where the second argument is a tuple. Silently convert that to an elipsis
            // so we don't have to deal with non-primitive local variables in the interepter
            const funRef = this.evalNP(expr.vArguments[0], state);
            const funRefT = this.typeOf(expr.vArguments[0]);

            let paramVs: Value[];

            const paramTupleT = this.typeOf(expr.vArguments[1]);
            const paramTs =
                paramTupleT instanceof rtt.TupleType ? paramTupleT.elementTypes : [paramTupleT];

            if (paramTs.length === 0) {
                paramVs = [];
            } else if (paramTs.length === 1) {
                paramVs = [this.evalNP(expr.vArguments[1], state)];
            } else {
                const paramTuple = this.evalNP(expr.vArguments[1], state);
                this.expect(paramTuple instanceof Array);
                paramVs = paramTuple;
            }

            args = [funRef, ...paramVs];
            argTs = [funRefT, ...paramTs];
        } else {
            args = expr.vArguments.map((argExpr) => this.evalNP(argExpr, state));
            argTs = expr.vArguments.map((argExpr) => this.typeOf(argExpr));
        }

        const results = this._execCall(fun, args, argTs, state);

        if (results.length === 0) {
            return none;
        }

        if (results.length === 1) {
            return results[0];
        }

        return results;
    }

    private makeMsgCall(msg: SolMessage, state: State, isDelegate: boolean): CallResult {
        const address = getThis(state);
        // Pesist our state changes before calling out
        this.world.updateAccount(state.account);

        // Call out
        let res: CallResult;

        if (msg.to.equals(rtt.ZERO_ADDRESS)) {
            this.expect(!isDelegate, `Contract deployments are never delegate calls`);
            res = this.world.create(msg);
        } else if (!isDelegate) {
            res = this.world.call(msg);
        } else {
            res = this.world.delegatecall(msg);
        }

        // Refresh our account from the world in case our state has changed
        const acc = this.world.getAccount(address);
        this.expect(acc !== undefined, `We shouldn't have been destroyed`);
        state.account = acc;

        return res;
    }

    private pushTempScope(tempTs: rtt.BaseRuntimeType[], state: State): TempsScope {
        const newScope = new TempsScope(tempTs, state, state.scope);

        for (const lv of newScope.temps) {
            newScope.set(lv.name, none);
        }

        state.scope = newScope;
        return newScope;
    }

    private _evalMsgCall(
        expr: sol.FunctionCall,
        callee: ExternalCallDescription,
        state: State
    ): CallResult {
        // eslint-disable-next-line prefer-const
        let [to, , value, gas, salt] = getExternalCallComponents(callee);
        let data: Uint8Array;
        let isLibCall: boolean;

        if (callee.target instanceof rtt.ExternalFunRef) {
            const astTarget = expr.vReferencedDeclaration;
            const selector = callee.target.selector;
            let argTs: rtt.BaseRuntimeType[];

            if (astTarget instanceof sol.FunctionDefinition) {
                argTs = astTarget.vParameters.vParameters.map((argT) =>
                    this.varDeclToRuntimeType(argT)
                );
            } else if (astTarget instanceof sol.VariableDeclaration) {
                this.expect(astTarget.stateVariable);
                [argTs] = getGetterArgAndReturnTs(astTarget, this._infer);
            } else {
                nyi(`External call target ${astTarget?.print()}`);
            }

            // Next compute the msg data
            const argVs = expr.vArguments.map((arg) => this.eval(arg, state));
            const ts = this.pushTempScope(argTs, state);
            this.assign(ts.temps, argVs, state);
            const argData = encode(ts.tempVals, argTs, state);
            this.popScope(state);

            this.expect(argData instanceof Uint8Array);
            data = concatBytes(selector, argData);

            const toContract = astTarget.vScope;
            this.expect(toContract instanceof sol.ContractDefinition);
            isLibCall = toContract.kind === sol.ContractKind.Library;
        } else if (callee.target instanceof NewCall) {
            const contract = (callee.target.type as sol.UserDefinedType)
                .definition as sol.ContractDefinition;
            const args = expr.vArguments.map((arg) => this.eval(arg, state));

            let argTs: BaseInterpType[] = [];

            if (contract.vConstructor) {
                const interp = this;
                argTs = contract.vConstructor.vParameters.vParameters.map((decl) =>
                    interp.varDeclToRuntimeType(decl)
                );
            }

            const ts = this.pushTempScope(argTs, state);
            this.assign(ts.temps, args, state);
            const argData = encode(ts.tempVals, argTs, state);
            this.popScope(state);

            this.expect(argData instanceof Uint8Array, ``);

            const newContractInfo = this.artifactManager.getContractInfo(contract);
            this.expect(newContractInfo !== undefined);

            const creationBytecode = newContractInfo.bytecode.bytecode;
            data = concatBytes(creationBytecode, argData);
            isLibCall = false;
        } else {
            const args = expr.vArguments.map((arg) => this.eval(arg, state));

            if (callee.callKind === "send" || callee.callKind === "transfer") {
                this.expect(
                    args.length === 1 && typeof args[0] === "bigint",
                    `Unexpected arguments to *call builtin`
                );
                data = new Uint8Array();
                isLibCall = false;
                value = args[0];
                gas = 2300n;
            } else {
                this.expect(args.length <= 1, `Unexpected arguments to *call builtin`);

                if (args.length === 1) {
                    this.expect(args[0] instanceof View, `Unexpected arguments to *call builtin`);
                    const dataView = this.implicitCoercion(args[0], memBytesT, state);
                    this.expect(dataView instanceof View && dataView.type instanceof rtt.BytesType);
                    data = decodeView(dataView, state) as Uint8Array;
                } else {
                    data = new Uint8Array();
                }

                isLibCall = callee.callKind === "delegatecall";
            }
        }

        // If this is a delegate call we preserve msg.sender
        const thisAddr = getThis(state);

        const msg: SolMessage = {
            from: isLibCall ? getMsgSender(state) : thisAddr,
            to,
            delegatingContract: isLibCall ? thisAddr : undefined,
            data,
            gas: gas === undefined ? 0n : gas,
            value: value === undefined ? 0n : value,
            salt: salt,
            isStaticCall: callee.callKind === "staticcall"
        };

        return this.makeMsgCall(msg, state, isLibCall);
    }

    private getValuesFromReturnedCalldata(
        data: Uint8Array,
        target: sol.FunctionDefinition | sol.VariableDeclaration,
        state: State
    ): Value[] {
        const retTs: rtt.BaseRuntimeType[] = [];

        if (target instanceof sol.FunctionDefinition) {
            for (const retT of target.vReturnParameters.vParameters) {
                retTs.push(changeLocTo(this.varDeclToRuntimeType(retT), sol.DataLocation.Memory));
            }
        } else if (target instanceof sol.VariableDeclaration) {
            this.expect(target.stateVariable);
            const [, getterRetT] = getGetterArgAndReturnTs(target, this._infer);
            retTs.push(...getterRetT);
        }

        return this.assertNotPoison(state, decode(data, retTs, state));
    }

    evalExternalCall(expr: sol.FunctionCall, callee: ExternalCallDescription, state: State): Value {
        const res = this._evalMsgCall(expr, callee, state);
        const astTarget = expr.vReferencedDeclaration;

        if (astTarget === undefined) {
            // address call builtins
            if (callee.callKind === "transfer") {
                if (res.reverted) {
                    this.runtimeError(RuntimeError, state, `Transfer failed`, res.data);
                }

                return none;
            }

            if (callee.callKind === "send") {
                return !res.reverted;
            }

            // *call builtins returns just bool for Solidity <0.5.0
            if (lt(getCodeContractInfo(state).artifact.compilerVersion, "0.5.0")) {
                return !res.reverted;
            }

            const encodedData = PointerMemView.allocMemFor(res.data, bytesT, state.memAllocator);
            encodedData.encode(res.data, state.memory, state.memAllocator);

            return [!res.reverted, encodedData];
        } else {
            this.expect(
                astTarget instanceof sol.FunctionDefinition ||
                astTarget instanceof sol.VariableDeclaration,
                `NYI External call target`
            );

            if (res.reverted) {
                this.runtimeError(RuntimeError, state, `External call failed`, res.data);
            }

            const rets: Value[] = this.getValuesFromReturnedCalldata(res.data, astTarget, state);
            return rets.length === 0 ? none : rets.length === 1 ? rets[0] : rets;
        }
    }

    resolveCallee(
        target: sol.FunctionDefinition | sol.ModifierDefinition,
        state: State
    ): sol.FunctionDefinition | sol.VariableDeclaration | sol.ModifierDefinition {
        if (target instanceof sol.FunctionDefinition && !isMethod(target)) {
            return target;
        }

        const contract = getContract(state);
        const res = sol.resolve(contract, target, this._infer);
        this.expect(
            res !== undefined,
            `Couldn't resolve ${target.name} in contract ${contract.name}`
        );

        return res;
    }

    /**
     * Internal call logic. Reused for both internal calls and modifiers. Its responsible for
     * pushing/popping internal stack frames and correctly setting the callee lexical scope and
     * restoring the caller scope
     *
     * When target is `sol.FunctionDefinition` return the `Value[]`s returned by the function. For modifiers returns [].
     */
    _execCall(
        target: sol.FunctionDefinition | sol.ModifierInvocation | BuiltinFunction,
        args: Value[],
        argTs: BaseInterpType[],
        state: State
    ): Value[] {
        // Save scope
        const savedScope = state.scope;
        let savedCurModifier: sol.ModifierInvocation | undefined;
        let callee: sol.FunctionDefinition | sol.ModifierDefinition | BuiltinFunction;

        if (target instanceof sol.FunctionDefinition || target instanceof BuiltinFunction) {
            callee = target;
        } else {
            callee = target.vModifier as sol.ModifierDefinition;
        }

        state.scope = this.makeScope(callee, args, argTs, state);
        this.nodes.push(target);

        if (target instanceof sol.FunctionDefinition || target instanceof BuiltinFunction) {
            state.intCallStack.push({
                callee: target,
                scope: state.scope as LocalsScope,
                curModifier: undefined
            });
        } else if (target instanceof sol.ModifierInvocation) {
            const frame = stackTop(state.intCallStack);
            savedCurModifier = frame.curModifier;
            frame.curModifier = target;
        }

        let res: Value[];
        if (target instanceof sol.FunctionDefinition) {
            const mods = getModifiers(target);

            if (mods.length > 0) {
                const mod = mods[0];
                const argVals = mod.vArguments.map((argE) => this.eval(argE, state));
                const argTs = mod.vArguments.map((argE) => this.typeOf(argE));
                this._execCall(mod, argVals, argTs, state);
            } else {
                this.expect(target.vBody !== undefined, `Can't call ${target.name} with no body.`);
                this.exec(target.vBody, state);
            }

            res = target.vReturnParameters.vParameters.map((ret, i) => {
                const res = (state.scope as BaseScope).lookup(LocalsScope.returnName(ret, i));
                if (res === undefined) {
                    this.fail(
                        NotDefined,
                        `Missing value for return ${LocalsScope.returnName(ret, i)}`
                    );
                }
                return res;
            });
        } else if (target instanceof sol.ModifierInvocation) {
            const mod = this.resolveCallee(target.vModifier as sol.ModifierDefinition, state);
            this.expect(
                mod instanceof sol.ModifierDefinition && mod.vBody !== undefined,
                `Can't call ${mod.name} with no body.`
            );
            this.exec(mod.vBody, state);
            res = [];
        } else {
            res = target.call(this, state, (state.scope as LocalsScope).node as BuiltinFunction);
        }

        const frame = stackTop(state.intCallStack);

        if (target instanceof sol.FunctionDefinition || target instanceof BuiltinFunction) {
            state.intCallStack.pop();
        } else {
            frame.curModifier = savedCurModifier;
        }

        this.nodes.pop();
        // Restore scope
        state.scope = savedScope;

        return res;
    }

    evalInternalCall(expr: sol.FunctionCall, callee: rtt.InternalFunRef, state: State): Value {
        const argVals = expr.vArguments.map((arg) => this.eval(arg, state));
        const argTs = expr.vArguments.map((arg) => this.typeOf(arg));
        const results = this._execCall(callee.fun, argVals, argTs, state);

        if (results.length === 0) {
            return none;
        }

        if (results.length === 1) {
            return results[0];
        }

        return results;
    }

    evalNewExpression(expr: sol.NewExpression): Value {
        const astT = this._infer.typeNameToSpecializedTypeNode(
            expr.vTypeName,
            sol.DataLocation.Memory
        );

        return new NewCall(astT);
    }

    evalNewCall(
        expr: sol.FunctionCall,
        callee: NewCall | ExternalCallDescription,
        state: State
    ): Value {
        const newCall = callee instanceof NewCall ? callee : (callee.target as NewCall);
        const astT = newCall.type;

        // Contract Creation
        if (
            astT instanceof sol.UserDefinedType &&
            astT.definition instanceof sol.ContractDefinition
        ) {
            const res = this._evalMsgCall(expr, liftExtCalRef(callee), state);

            if (res.reverted) {
                this.runtimeError(RuntimeError, state, "Contract creation reverted", res.data);
            }

            this.expect(res.newContract !== undefined);
            return res.newContract;
        }

        // Memory allocation
        const args = expr.vArguments.map((arg) => this.eval(arg, state));

        let newT = this.astToRuntimeType(astT, sol.DataLocation.Memory);
        this.expect(newT instanceof rtt.PointerType, ``);
        newT = newT.toType;
        this.expect(
            (newT instanceof rtt.ArrayType ||
                newT instanceof rtt.BytesType ||
                newT instanceof rtt.StringType) &&
            args.length === 1 &&
            typeof args[0] === "bigint",
            `Expected an array type with a single length argument not ${newT.pp()} with ${args}`
        );

        const arrSize = bigIntToNum(args[0], 0n, MAX_ARR_DECODE_LIMIT);

        let initialVal: BaseValue;
        let addr: bigint;

        if (newT instanceof rtt.ArrayType) {
            initialVal = [];

            for (let i = 0; i < arrSize; i++) {
                initialVal.push(makeZeroValue(newT.elementT, state));
            }

            addr = state.memAllocator.alloc(32 * arrSize + 32);
        } else {
            initialVal =
                newT instanceof rtt.BytesType ? new Uint8Array(arrSize) : `\x00`.repeat(arrSize);
            addr = state.memAllocator.alloc(arrSize + 32);
        }

        const view = makeMemoryView(newT, addr);
        view.encode(initialVal, state.memory, state.memAllocator);

        return view;
    }

    evalFunctionCallOptions(expr: sol.FunctionCallOptions, state: State): Value {
        const base = this.evalNP(expr.vExpression, state);
        this.expect(
            base instanceof rtt.ExternalFunRef ||
            base instanceof Address ||
            base instanceof NewCall ||
            base instanceof ExternalCallDescription
        );

        const res = liftExtCalRef(base);

        // @todo The order of operations here may not match whats implemented!!!
        for (const [name, optExpr] of expr.vOptionsMap) {
            let optV = this.evalNP(optExpr, state);
            this.expect(isPrimitiveValue(optV));
            const expectedT = name === "salt" ? bytes32 : rtt.uint256;

            optV = this.implicitCoercion(optV, expectedT, state) as NonPoisonValue;

            if (name === "value") {
                this.expect(typeof optV === "bigint");
                res.value = optV;
            } else if (name === "gas") {
                this.expect(typeof optV === "bigint");
                res.gas = optV;
            } else if (name === "salt") {
                this.expect(optV instanceof Uint8Array);
                res.salt = optV;
            } else {
                nyi(`Function option ${name}`);
            }
        }

        return res;
    }

    evalFunctionCall(expr: sol.FunctionCall, state: State): Value {
        let callee: Value;

        if (
            expr.kind === sol.FunctionCallKind.TypeConversion ||
            expr.kind === sol.FunctionCallKind.StructConstructorCall
        ) {
            callee = this.evalTypeExpression(expr.vExpression, state, sol.DataLocation.Memory);
        } else {
            callee = this.evalNP(expr.vExpression, state);
        }

        if (expr.kind === sol.FunctionCallKind.TypeConversion) {
            this.expect(
                callee instanceof BaseTypeValue,
                `Type conversion expects a type as its callee`
            );
            callee = unwrapUnaryTypeTuples(callee);
            return this.evalTypeConversion(expr, (callee as TypeValue).type, state);
        }

        if (expr.kind === sol.FunctionCallKind.StructConstructorCall) {
            this.expect(
                callee instanceof TypeValue && callee.type instanceof rtt.StructType,
                `Struct constructors expect a type as its callee not ${ppValue(callee)}`
            );

            return this.evalStructConstructorCall(expr, callee.type, state);
        }

        // Builtin call
        if (callee instanceof BuiltinFunction) {
            return this.evalBuiltinCall(expr, callee, state);
        }

        // New calls (memory allocation or contract deployments)
        if (
            callee instanceof NewCall ||
            (callee instanceof ExternalCallDescription && callee.target instanceof NewCall)
        ) {
            return this.evalNewCall(expr, callee, state);
        }

        // External calls
        if (callee instanceof rtt.ExternalFunRef || callee instanceof ExternalCallDescription) {
            return this.evalExternalCall(expr, liftExtCalRef(callee), state);
        }

        // Internal calls
        if (callee instanceof rtt.InternalFunRef) {
            return this.evalInternalCall(expr, callee, state);
        }

        console.error(callee);
        nyi(`Call to ${ppValue(callee)} ${callee.constructor.name}`);
    }

    evalIdentifier(expr: sol.Identifier, state: State): Value {
        if (expr.vIdentifierType === sol.ExternalReferenceType.Builtin && expr.name === "this") {
            return getThis(state);
        }

        if (expr.vIdentifierType === sol.ExternalReferenceType.Builtin && expr.name === "super") {
            const contract = getCodeContract(state);
            this.expect(contract.vLinearizedBaseContracts.length > 1, `Unexpected call to super() in contract with no bases`);
            return new DefValue(contract.vLinearizedBaseContracts[1]);
        }

        // contract name
        if (expr.vReferencedDeclaration instanceof sol.ContractDefinition) {
            return new DefValue(expr.vReferencedDeclaration);
        }

        if (expr.vReferencedDeclaration instanceof sol.FunctionDefinition) {
            const contract = getCodeContract(state);
            let def: any = expr.vReferencedDeclaration;

            def = (isMethod(def) && def.visibility !== sol.FunctionVisibility.External) ? sol.resolve(contract, def, this._infer) : def;
            this.expect(def instanceof sol.FunctionDefinition, `Unexpected resolution of ${expr.name} to ${def}`)

            return new rtt.InternalFunRef(def);
        }

        // named SourceUnit import
        if (expr.vReferencedDeclaration instanceof sol.ImportDirective) {
            this.expect(
                expr.vReferencedDeclaration.unitAlias !== "",
                `Unexpected identifier of an unnamed import`
            );
            return new DefValue(expr.vReferencedDeclaration.vSourceUnit);
        }

        if (!state.scope) {
            this.fail(NoScope, ``);
        }

        const res = state.scope.lookup(expr.name);

        if (res === undefined) {
            this.fail(NotDefined, ``);
        }

        return res;
    }

    evalIndexAccess(expr: sol.IndexAccess, state: State): Value {
        this.expect(expr.vIndexExpression !== undefined, `Mising index expression in eval`);
        const baseT = this.typeOf(expr.vBaseExpression);

        let baseVal = this.evalNP(expr.vBaseExpression, state);
        const indexVal = this.evalNP(expr.vIndexExpression, state);

        let res: Value;

        if (isPointerView(baseVal)) {
            baseVal = deref(baseVal, state);
        }

        if (isArrayLikeView(baseVal)) {
            this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);
            if (isArrayLikeMemView(baseVal)) {
                res = baseVal.indexView(indexVal, state.memory);
            } else if (isArrayLikeCalldataView(baseVal)) {
                res = baseVal.indexView(indexVal, getMsg(state));
            } else if (isArrayLikeStorageView(baseVal)) {
                res = baseVal.indexView(indexVal, getStateStorage(state));
            } else {
                nyi(`Array like view ${baseVal.constructor.name}`);
            }

            if (res instanceof Poison) {
                this.runtimeError(OOBError, state);
            }

            res = this.lvToValue(res, state);
        } else if (baseVal instanceof Uint8Array) {
            this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);
            this.expect(
                baseT instanceof rtt.FixedBytesType,
                `Expected a stack fixed byte var in base index`
            );

            if (indexVal < 0n || indexVal >= baseT.numBytes) {
                this.runtimeError(OOBError, state);
            }

            res = BigInt(baseVal[Number(indexVal)]);
        } else if (baseVal instanceof MapStorageView) {
            const key =
                indexVal instanceof View
                    ? decodeView(indexVal, state)
                    : (indexVal as PrimitiveValue);
            const idxView = baseVal.indexView(key);
            res = this.lvToValue(idxView, state);
        } else {
            nyi(`Index access base ${baseVal}`);
        }

        if (res instanceof DecodingFailure) {
            this.runtimeError(OOBError, state);
        }

        // @todo add test for order of operations
        return res;
    }

    evalIndexRangeAccess(expr: sol.IndexRangeAccess, state: State): Value {
        const base = this.evalNP(expr.vBaseExpression, state);
        const start =
            expr.vStartExpression !== undefined ? this.evalNP(expr.vStartExpression, state) : 0n;
        let end = expr.vEndExpression !== undefined ? this.evalNP(expr.vEndExpression, state) : -1n;

        this.expect(typeof start === "bigint" && typeof end === "bigint");
        this.expect(
            base instanceof rtt.BytesCalldataView ||
            base instanceof rtt.StringCalldataView ||
            base instanceof rtt.ArrayCalldataView ||
            base instanceof MsgDataView
        );

        const cd = getMsg(state);
        const indexableView =
            base instanceof rtt.StringCalldataView
                ? new rtt.BytesCalldataView(bytesT, base.offset, base.base)
                : base;
        const actualLen = indexableView.size(cd);
        this.expect(typeof actualLen === "bigint");

        // If end range is ommitted assume the length
        end = end < 0n ? actualLen : end;

        const len = end - start;

        if (start < 0 || end < start || end > actualLen) {
            this.runtimeError(NoPayloadError, state);
        }

        const rangeOffset = indexableView.indexView(start, cd);
        this.expect(rangeOffset instanceof BaseCalldataView);
        const startOffset = rangeOffset.offset + rangeOffset.base;

        if (base instanceof rtt.BytesCalldataView) {
            return new rtt.BytesSliceCalldataView(startOffset, len);
        } else if (base instanceof rtt.StringCalldataView || base instanceof MsgDataView) {
            return new rtt.StringSliceCalldataView(startOffset, len);
        } else {
            return new rtt.ArraySliceCalldataView(base.type, startOffset, len);
        }
    }

    evalLiteral(expr: sol.Literal, state: State): Value {
        if (expr.kind === sol.LiteralKind.Number) {
            const v = sol.evalLiteral(expr);
            this.expect(typeof v === "bigint", ``);
            // This is hack to match the behavior of InferType.typeOf() for certain hex literals.
            return expr.typeString.startsWith("address") ? new Address(bigIntToBytes(v)) : v;
        }

        if (expr.kind === sol.LiteralKind.Bool) {
            return expr.value === "true";
        }

        this.expect(
            expr.kind === sol.LiteralKind.String ||
            expr.kind === sol.LiteralKind.HexString ||
            expr.kind === sol.LiteralKind.UnicodeString
        );

        const view = state.constantsMap.get(expr.id);
        this.expect(view !== undefined, `Missing string/bytes literal`);
        return view;
    }

    evalBuiltinMemberAccess(
        expr: sol.MemberAccess,
        val: Value,
        baseVal: Value,
        state: State
    ): Value {
        if (val instanceof BuiltinFunction && val.implicitFirstArg) {
            val = val.curry([baseVal], [this.typeOf(expr.vExpression)]);
        }

        if (val instanceof BuiltinFunction && val.isField) {
            const res = this._execCall(val, [], [], state);
            this.expect(res.length === 1);

            return res[0];
        }

        return val;
    }

    private getBuiltin(state: State, ...path: string[]): Value {
        let s = state.scope;

        // @todo: stupid. fix
        while (s !== undefined && !(s instanceof BuiltinsScope)) {
            s = s._next;
        }

        this.expect(s !== undefined, `No builtin scope`);

        let res: Value | undefined = s.builtins;

        for (const id of path) {
            this.expect(res instanceof BuiltinStruct);
            res = res.getField(id);
        }

        this.expect(res instanceof BuiltinStruct || res instanceof BuiltinFunction, ``);

        return res;
    }

    private getBuiltinStruct(state: State, ...path: string[]): BuiltinStruct {
        const res = this.getBuiltin(state, ...path);
        this.expect(res instanceof BuiltinStruct);
        return res;
    }

    evalMemberAccess(expr: sol.MemberAccess, state: State): Value {
        let baseVal = this.evalNP(expr.vExpression, state);

        if (baseVal instanceof Address) {
            // Builtin
            if (expr.vReferencedDeclaration === undefined) {
                const addressBuiltinStruct = this.getBuiltinStruct(
                    state,
                    ADDRESS_BUILTIN_STRUCT_NAME
                );
                const res = addressBuiltinStruct.getField(expr.memberName);

                this.expect(res !== undefined, `Unknown field ${expr.memberName}`);

                return this.evalBuiltinMemberAccess(expr, res, baseVal, state);
            }

            const solT = this._infer.typeOf(expr.vExpression);

            if (
                solT instanceof sol.UserDefinedType &&
                solT.definition instanceof sol.ContractDefinition
            ) {
                const def = expr.vReferencedDeclaration;
                if (
                    def instanceof sol.FunctionDefinition ||
                    (def instanceof sol.VariableDeclaration &&
                        def.visibility === sol.StateVariableVisibility.Public)
                ) {
                    const selector = hexToBytes(`0x${this._infer.signatureHash(def)}`);

                    return new rtt.ExternalFunRef(baseVal, selector);
                }
            }
        }

        if (
            baseVal instanceof rtt.ExternalFunRef ||
            baseVal instanceof ExternalCallDescription ||
            baseVal instanceof NewCall
        ) {
            const externalCallableBuiltinStruct = this.getBuiltinStruct(
                state,
                EXTERNAL_CALL_CALLABLE_FIELDS_NAME
            );
            const res = externalCallableBuiltinStruct.getField(expr.memberName);
            this.expect(res !== undefined, `Unknown field ${expr.memberName}`);

            return this.evalBuiltinMemberAccess(expr, res, baseVal, state);
        }

        if (isPointerView(baseVal)) {
            baseVal = deref(baseVal, state);
        }

        if (
            baseVal instanceof StructMemView ||
            baseVal instanceof StructCalldataView ||
            baseVal instanceof StructStorageView
        ) {
            const fieldView = baseVal.fieldView(expr.memberName);
            this.expect(
                !(fieldView instanceof DecodingFailure),
                `Unknown field ${expr.memberName}`
            );
            return this.lvToValue(fieldView, state);
        }

        if (baseVal instanceof BuiltinStruct) {
            const res = baseVal.getField(expr.memberName);
            this.expect(res !== undefined, `Unknown field ${expr.memberName}`);
            return this.evalBuiltinMemberAccess(expr, res, baseVal, state);
        }

        if (isArrayLikeView(baseVal) && expr.memberName === "length") {
            return length(baseVal, state);
        }

        if (baseVal instanceof DefValue) {
            if (
                (baseVal.def instanceof sol.EventDefinition ||
                    baseVal.def instanceof sol.ErrorDefinition) &&
                expr.memberName === "selector"
            ) {
                return hexToBytes(`0x${this._infer.signatureHash(baseVal.def)}`);
            }

            if (baseVal.def instanceof sol.EnumDefinition) {
                const res = indexOfEnumOption(baseVal.def, expr.memberName);
                this.expect(res !== undefined);
                return BigInt(res);
            }

            // Lib.Fun where Fun is external is an external fun ref
            if (
                baseVal.def instanceof sol.ContractDefinition &&
                baseVal.def.kind === sol.ContractKind.Library &&
                expr.vReferencedDeclaration instanceof sol.FunctionDefinition &&
                expr.vReferencedDeclaration.visibility === sol.FunctionVisibility.External
            ) {
                const addr = getLibraryLinkedAddress(baseVal.def, state);
                const selector = hexToBytes(
                    `0x${this._infer.signatureHash(expr.vReferencedDeclaration)}`
                );
                return new rtt.ExternalFunRef(addr, selector);
            }

            // Contract.Fun where Fun is NOT external is an internal fun ref
            if (
                baseVal.def instanceof sol.ContractDefinition &&
                expr.vReferencedDeclaration instanceof sol.FunctionDefinition &&
                expr.vReferencedDeclaration.visibility !== sol.FunctionVisibility.External
            ) {
                return new rtt.InternalFunRef(expr.vReferencedDeclaration);
            }

            // BaseContract.stateVariable
            if (
                baseVal.def instanceof sol.SourceUnit ||
                (baseVal.def instanceof sol.ContractDefinition &&
                    isBaseOf(baseVal.def, getCodeContract(state)))
            ) {
                const scope = this.makeStaticScope(baseVal.def, state);
                const res = scope.lookup(expr.memberName);
                this.expect(
                    res !== undefined,
                    `Couldnt find ${expr.memberName} in ${ppValue(baseVal)}`
                );

                return res;
            }

            // - source unit definitions/constants
            // - contract constants. We need to tweak how we built scope here
            if (
                baseVal.def instanceof sol.SourceUnit ||
                (baseVal.def instanceof sol.ContractDefinition &&
                    expr.vReferencedDeclaration instanceof sol.VariableDeclaration &&
                    expr.vReferencedDeclaration.mutability === sol.Mutability.Constant)
            ) {
                const scope =
                    baseVal.def instanceof sol.SourceUnit
                        ? new GlobalScope(baseVal.def, state, this._infer, undefined)
                        : new ContractScope(baseVal.def, this._infer, state, undefined);
                const res = scope.lookup(expr.memberName);
                this.expect(
                    res !== undefined,
                    `Couldnt find ${expr.memberName} in ${ppValue(baseVal)}`
                );

                return res;
            }

            if (expr.vReferencedDeclaration instanceof sol.EnumDefinition) {
                return new DefValue(expr.vReferencedDeclaration);
            }
        }

        if (
            (isArrayLikeStorageView(baseVal) && expr.memberName === "push") ||
            expr.memberName === "pop"
        ) {
            const res = expr.memberName === "push" ? pushBuiltin : popBuiltin;
            return this.evalBuiltinMemberAccess(expr, res, baseVal, state);
        }

        nyi(`Member access of ${expr.memberName} in ${ppValue(baseVal)}`);
    }

    evalTupleExpression(expr: sol.TupleExpression, state: State): Value {
        // A copmonent here may be an empty tuple, so we use allow poison in non-null components
        const compVals: Value[] = expr.vOriginalComponents.map((comp) =>
            comp === null ? none : this.eval(comp, state)
        );

        // Array literals get allocated in memory
        if (expr.isInlineArray) {
            const arrPtrT = this.typeOf(expr);
            this.expect(
                arrPtrT instanceof rtt.PointerType &&
                arrPtrT.toType instanceof rtt.ArrayType &&
                arrPtrT.toType.size !== undefined,
                `Expected a fixed size array in memory not ${arrPtrT.pp()}`
            );

            const arrView = PointerMemView.allocMemFor(
                undefined,
                arrPtrT.toType,
                state.memAllocator
            );
            this.expect(arrView instanceof ArrayMemView, ``);

            for (let i = 0n; i < arrPtrT.toType.size; i++) {
                const idxView = arrView.indexView(i, state.memory);
                this.expect(!(idxView instanceof DecodingFailure), ``);
                this.assign(idxView, compVals[bigIntToNum(i)] as PrimitiveValue, state);
            }

            return arrView;
        }

        if (compVals.length === 0) {
            return none;
        }

        if (compVals.length === 1) {
            return compVals[0];
        }

        return compVals;
    }

    expect(b: boolean, msg?: string): asserts b {
        if (!b) {
            this.fail(InternalError, msg ? msg : ``);
        }
    }

    isUnchecked(n: sol.ASTNode): boolean {
        // In Solidity older than 0.8.0 all operations are unchecked
        if (lt(this.compilerVersion, "0.8.0")) {
            return true;
        }

        // In Solidity after 0.8.0 only operations inside an unchecked block are unchecked.
        return n.getClosestParentByType(sol.UncheckedBlock) !== undefined;
    }

    /**
     * Convert an LValue to an RValue.
     */
    public lvToValue(lv: LValue | Poison, state: State): Value {
        if (lv instanceof Poison) {
            return lv;
        }

        if (lv instanceof View) {
            if (isValueType(lv.type)) {
                return decodeView(lv, state) as PrimitiveValue;
            }

            if (isPointerView(lv)) {
                return deref(lv, state);
            }

            nyi(`Unexpected LValue view ${lv.pp()}`);
        } else if (lv instanceof Array) {
            return lv.map((x) => this.lvToValue(x, state));
        } else if (lv === null) {
            return none;
        }

        nyi(`LValue: ${lv}`);
    }

    evalUnaryOperation(expr: sol.UnaryOperation, state: State): Value {
        if (sol.isConstant(expr)) {
            return solcValueToValue(sol.evalUnary(expr, this._infer));
        }

        if (expr.vUserFunction) {
            nyi(`Unary user functions`);
        }

        if (expr.operator === "!") {
            const subVal = this.evalT(expr.vSubExpression, Boolean, state);
            return !subVal;
        }

        // In all other cases the result is bigint
        let res: bigint;
        const unchecked = this.isUnchecked(expr);
        const t = this.typeOf(expr);

        // Prefix/infix inc/dec require special handling as we need to
        // eval the subexpression as an LV. We can't evaluate it multiple times, as that may
        // duplicate state changes.
        if (expr.operator === "++" || expr.operator == "--") {
            const subExprLoc = this.evalLV(expr.vSubExpression, state);
            const subVal = this.lvToValue(subExprLoc, state);
            this.expect(typeof subVal === "bigint", `Unexpected value ${subVal} for unary ~`);
            if (state.scope === undefined) {
                this.fail(NoScope, `Need scope for ${expr.operator}`);
            }

            const newVal = this.clamp(
                expr.operator === "++" ? subVal + 1n : subVal - 1n,
                t,
                unchecked,
                state
            );
            this.assign(subExprLoc, newVal, state);
            res = expr.prefix ? newVal : subVal;

            return res;
        }

        const subVal = this.evalT(expr.vSubExpression, BigInt, state);

        if (expr.operator === "-") {
            res = -subVal;
        } else if (expr.operator === "~") {
            res = ~subVal;
        } else {
            // @todo implement delete
            nyi(`Unary operator ${expr.operator}`);
        }

        return this.clamp(res, t, unchecked, state);
    }

    /**
     * Given a node make a scope for it up to the containing contract.
     * This will include the builtins, globals and contract scopes.
     *
     * This scope is used to:
     * 1. Compute constant expressions
     * 2. As a basis for dynamic runtime scopes. Those build on this scope with LocalScopes for function args, locals, etc..
     */
    public makeStaticScope(nd: sol.ASTNode | BuiltinFunction | undefined, state: State): BaseScope {
        const scopeNodes: Array<sol.SourceUnit | sol.ContractDefinition> = [];

        if (nd instanceof BuiltinFunction) {
            return makeBuiltinScope(state, this.compilerVersion);
        }

        while (nd !== undefined) {
            if (nd instanceof sol.SourceUnit) {
                scopeNodes.push(nd);
            }

            if (nd instanceof sol.ContractDefinition) {
                if (nd.kind === sol.ContractKind.Library) {
                    // Library internal functions execute in the scope of the library
                    scopeNodes.push(nd);
                } else {
                    // Normal methods execute in the scope of the *most derived contract*, not their defining contract.
                    // The reason here is to get the correct layout locations for base contract state variables in the MDC's layout
                    scopeNodes.push(getCodeContract(state));
                }
            }

            nd = nd.parent;
        }

        scopeNodes.reverse();
        let scope: BaseScope = makeBuiltinScope(state, this.compilerVersion);

        for (const nd of scopeNodes) {
            if (nd instanceof sol.SourceUnit) {
                scope = new GlobalScope(nd, state, this._infer, scope);
            } else {
                scope = new ContractScope(nd, this._infer, state, scope);
            }
        }

        return scope;
    }

    /**
     * Make the lexical scope for a given function or modifier. This also sets the argument values (and zero values for returns) for that scope.
     * @param nd
     * @param args
     * @param state
     * @param infer
     * @returns
     */
    makeScope(
        nd: sol.FunctionDefinition | sol.ModifierDefinition | BuiltinFunction,
        args: Value[],
        argTs: BaseInterpType[],
        state: State
    ): BaseScope {
        const staticScope = this.makeStaticScope(nd, state);
        let localNames: string[];
        let localVals: Value[];

        if (nd instanceof BuiltinFunction) {
            nd = nd.concretize(argTs);
            localNames = nd.type.argTs.map((_, i) => `arg_${i}`);
            localVals = [...nd.curriedArgs, ...args];
        } else {
            localNames = nd.vParameters.vParameters.map((d) => d.name);
            localVals = [...args];
        }

        // We keep the returns in the function scope as well
        if (nd instanceof sol.FunctionDefinition) {
            localNames.push(
                ...nd.vReturnParameters.vParameters.map((ret, i) => LocalsScope.returnName(ret, i))
            );
            localVals.push(
                ...nd.vReturnParameters.vParameters.map((ret) => {
                    const type = this.varDeclToRuntimeType(ret);
                    return makeZeroValue(type, state);
                })
            );
        }

        sol.assert(
            localNames.length === localVals.length,
            `Mismatch in args in call to ${nd.name} expected ${localNames.length} got ${localVals.length}`
        );

        const res = new LocalsScope(nd, state, this.compilerVersion, staticScope);

        for (let i = 0; i < localNames.length; i++) {
            const v = res.lookupLocation(localNames[i]);
            this.expect(v !== undefined, ``);
            this.assign(v, localVals[i], state);
        }

        return res;
    }

    /**
     * Check that none of the passed in values are Poison. If any of them is poison throw a runtime exception
     */
    public assertNotPoison(state: State, vals: Value[]): Value[] {
        for (const v of vals) {
            if (v instanceof ExternalCallDescription || v instanceof NewCall) {
                continue;
            }

            if (v instanceof Array) {
                this.assertNotPoison(state, v);
                continue;
            }

            if (isPoison(v)) {
                this.runtimeError(NoPayloadError, state);
            }
        }

        return vals;
    }
}
