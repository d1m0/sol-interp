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
    PointerView,
    Poison,
    StateArea,
    View,
    Value as BaseValue,
    StructMemView,
    StructCalldataView,
    StructStorageView,
    simplifyType,
    PrimitiveValue,
    ExpStructType,
    makeMemoryView,
    bigIntToNum,
    ArrayMemView,
    MapStorageView,
    StringMemView,
    BytesMemView,
    StringCalldataView,
    StringStorageView,
    BytesStorageView,
    MAX_ARR_DECODE_LIMIT,
    ArrayLikeView,
    BytesCalldataView,
    stackTop,
    ArtifactInfo,
    DefaultAllocator,
    ImmMap,
    ZERO_ADDRESS,
    isPoison
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import { WorldInterface, State, SolMessage } from "./state";
import { EvalStep, ExecStep, Trace } from "./step";
import {
    InternalError,
    InterpError,
    NoScope,
    NotDefined,
    OOB,
    Overflow,
    RuntimeError
} from "./exceptions";
import { gte, lt } from "semver";
import {
    BuiltinFunction,
    BuiltinStruct,
    DefValue,
    isPrimitiveValue,
    LValue,
    match,
    none,
    NonPoisonValue,
    TypeConstructorToValueType,
    Value,
    ValueTypeConstructors
} from "./value";
import { Address, bigIntToBytes, bytesToHex, equalsBytes, hexToBytes } from "@ethereumjs/util";
import { BaseScope, BuiltinsScope, ContractScope, GlobalScope, LocalsScope } from "./scope";
import {
    changeLocTo,
    getModifiers,
    getMsg,
    isMethod,
    isStructView,
    isValueType,
    makeZeroValue,
    printNode
} from "./utils";
import { BaseStorageView, BaseMemoryView, BaseCalldataView } from "sol-dbg";
import {
    BaseLocalView,
    ArrayLikeLocalView,
    isArrayLikeView,
    isPointerView,
    PointerLocalView,
    PrimitiveLocalView
} from "./view";
import { ppLValue, ppValue, ppValueTypeConstructor } from "./pp";
import { assertBuiltin, popBuiltin, pushBuiltin } from "./builtins";
import { ArtifactManager } from "./artifactManager";

enum ControlFlow {
    Fallthrough = 0,
    Break = 1,
    Continue = 2,
    Return = 3
}

const scratchWord = new Uint8Array(32);

/**
 * Helper to decide if we should skip a struct field when assing memory structs due to it containing a map
 */
export function skipFieldDueToMap(t: sol.TypeNode): boolean {
    if (t instanceof sol.MappingType) {
        return true;
    }

    if (t instanceof sol.PointerType) {
        return skipFieldDueToMap(t.to);
    }

    if (t instanceof sol.ArrayType) {
        return skipFieldDueToMap(t.elementT);
    }

    return false;
}

/**
 * Solidity Interpeter class. Includes the following entrypoint
 *
 * * evaluate a single expression
 *      `eval(expr: sol.Expression, state: State): Value`
 * * execute one statement
 *      `exec(stmt: sol.Statement, state: State): ControlFlow`
 * * call an internal function
 *      `callInternal(callee: sol.FunctionDefinition, args: Value[], state: State)`
 * * call an external method
 *      @todo
 *
 * Most of the Interpreter state is kept in the `State` object that is passed around. The only runtime state
 * this class maintains is mostly for debugging purposes:
 *  - AST node stack of currently executed/evaluated objects
 */
export class Interpreter {
    nodes: Array<sol.ASTNode | BuiltinFunction>;
    _trace: Trace;

    get compilerVersion(): string {
        return this.artifact.compilerVersion;
    }

    _infer: sol.InferType;

    constructor(
        protected readonly world: WorldInterface,
        protected readonly artifactManager: ArtifactManager,
        protected readonly artifact: ArtifactInfo
    ) {
        this.nodes = [];
        this._trace = [];
        this._infer = new sol.InferType(this.compilerVersion);
    }

    get curNode(): sol.ASTNode | BuiltinFunction {
        sol.assert(this.nodes.length > 0, `No cur node`);
        return this.nodes[this.nodes.length - 1];
    }

    get trace(): Trace {
        return this._trace;
    }

    /**
     * An internal interpreter exception. This indicates a bug in the interpreter
     */
    fail(
        errorConstr: new (...args: any[]) => InternalError,
        msg: string,
        ctx: sol.ASTNode | BuiltinFunction = this.curNode
    ): never {
        throw new errorConstr(ctx, this._trace, msg);
    }

    /**
     * A runtime error. This indicates an actual EVM exception at runtime
     */
    runtimeError(errorConstr: new (...args: any[]) => RuntimeError, msg: string): never {
        throw new errorConstr(this.curNode, this._trace, msg);
    }

    ///*********************EXTERNAL FUNCTION CALLS************************************
    public create(msg: SolMessage, state: State): Address {
        nyi(`create(${msg}, ${state})`);
    }

    public call(msg: SolMessage, state: State): Value[] | InternalError {
        nyi(`create(${msg}, ${state})`);
    }

    private pushScope(node: sol.ASTNode, vals: Array<[string, Value]>, state: State): void {
        if (
            node instanceof sol.FunctionDefinition ||
            node instanceof sol.ModifierDefinition ||
            node instanceof sol.Block ||
            node instanceof sol.UncheckedBlock ||
            node instanceof sol.VariableDeclarationStatement
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

    ///*********************MODIFIERS/INTERNAL FUNCTION CALLS**************************
    /**
     * Make an internal call to `callee` with arguments `args` in state `state`.
     * @param callee
     * @param args
     * @param state
     */
    public callInternal(
        callee: sol.FunctionDefinition,
        args: Value[],
        argTs: sol.TypeNode[],
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
            /*
        } else if (stmt instanceof sol.EmitStatement) {
            res = this.execEmitStatement(stmt, state);
        } else if (stmt instanceof sol.InlineAssembly) {
            res = this.execInlineAssembly(stmt, state);
        } else if (stmt instanceof sol.RevertStatement) {
            res = this.execRevertStatement(stmt, state);
        } else if (stmt instanceof sol.Throw) {
            res = this.execThrow(stmt, state);
        } else if (stmt instanceof sol.TryCatchClause) {
            res = this.execTryCatchClause(stmt, state);
        } else if (stmt instanceof sol.TryStatement) {
            res = this.execTryStatement(stmt, state);
            */
        } else {
            nyi(`Stmt ${stmt.constructor.name}`);
        }

        this._trace.push(new ExecStep(stmt));
        this.nodes.pop();

        return res;
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
                const type = simplifyType(
                    this._infer.variableDeclarationToTypeNode(d),
                    this._infer,
                    undefined
                );
                return makeZeroValue(type, state);
            });
        }

        // VariableDeclarationStatements are their own scope on solidity >0.5.0 and
        // when theyre in the initialization of a for loop.
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
                        const type = simplifyType(
                            this._infer.variableDeclarationToTypeNode(decl),
                            this._infer,
                            undefined
                        );
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
            retVals =
                stmt.vExpression instanceof sol.TupleExpression ? (retVal as Value[]) : [retVal];
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
            fun !== undefined &&
                (retVals.length === fun.vReturnParameters.vParameters.length ||
                    retVals.length === 0),
            `Mismatch in number of ret vals and formal returns`
        );

        for (let i = 0; i < retVals.length; i++) {
            const retName = LocalsScope.returnName(fun?.vReturnParameters.vParameters[i], i);
            state.scope.set(retName, retVals[i]);
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
            const modArgTs = nextMod.vArguments.map((argE) => this._infer.typeOf(argE));
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
        } else if (expr instanceof sol.ElementaryTypeNameExpression) {
            res = this.evalElementaryTypeNameExpression(expr, state);
        } else if (expr instanceof sol.FunctionCall) {
            res = this.evalFunctionCall(expr, state);
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
        } else {
            nyi(`evalExpression(${expr.constructor.name})`);
        }

        // console.error(`eval(${printNode(expr)})->${ppValue(res)}`)
        this._trace.push(new EvalStep(expr, res));
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

    deref<T extends StateArea>(
        v: PointerView<T, View>,
        state: State
    ): View<any, BaseValue, any, sol.TypeNode> {
        let res: View<any, BaseValue, any, sol.TypeNode> | DecodingFailure;

        if (v instanceof PointerMemView) {
            res = v.toView(state.memory);
        } else if (v instanceof PointerCalldataView) {
            res = v.toView(getMsg(state));
        } else if (v instanceof PointerStorageView) {
            res = v.toView();
        } else if (v instanceof PointerLocalView) {
            res = v.toView();
        } else {
            nyi(`Pointer view ${v.constructor.name}`);
        }

        if (res instanceof DecodingFailure) {
            this.fail(InternalError, `Couldn't deref pointer view ${v}`);
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
                baseLV = this.deref(baseLV, state);
            }

            let idxView: LValue | DecodingFailure;

            if (isArrayLikeView(baseLV)) {
                this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);

                if (isArrayLikeMemView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, state.memory);
                } else if (isArrayLikeCalldataView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, getMsg(state));
                } else if (isArrayLikeStorageView(baseLV)) {
                    idxView = baseLV.indexView(indexVal, state.storage);
                } else if (baseLV instanceof ArrayLikeLocalView) {
                    idxView = baseLV.indexView(indexVal);
                } else {
                    nyi(`Unkown ArrayLikeView ${baseLV.constructor.name}`);
                }
            } else if (baseLV instanceof MapStorageView) {
                const key =
                    indexVal instanceof View
                        ? this.decode(indexVal, state)
                        : (indexVal as PrimitiveValue);
                idxView = baseLV.indexView(key);
            } else {
                nyi(`Index access base ${ppLValue(baseLV)}`);
            }

            if (idxView instanceof DecodingFailure) {
                this.runtimeError(OOB, `Failed decoding index LValue`);
            }

            res = idxView;
        } else if (expr instanceof sol.MemberAccess) {
            let baseLV = this.evalLV(expr.vExpression, state);
            this.expect(
                baseLV instanceof View,
                `Expected IndexAccess LValue ${expr.print()} to evaluate to a view, not ${baseLV}`
            );

            if (isPointerView(baseLV)) {
                baseLV = this.deref(baseLV, state);
            }

            if (isStructView(baseLV)) {
                const fieldView = baseLV.fieldView(expr.memberName);
                this.expect(
                    fieldView instanceof View,
                    `No field ${expr.memberName} found on base ${baseLV.pp()}`
                );

                res = fieldView;
            } else {
                nyi(`evalLV(${printNode(expr)}): ${ppLValue(baseLV)}`);
            }
        } else {
            nyi(`evalLV(${expr.print()})`);
        }

        this._trace.push(new EvalStep(expr, res));
        this.nodes.pop();

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
            const lvT = changeLocTo(lvalue.type.to, sol.DataLocation.Default).pp();
            const rvT = changeLocTo(rvalue.type, sol.DataLocation.Default).pp();
            this.expect(
                lvT === rvT,
                `Mismatching types in copying ref assignment (modulo location): ${lvT} and ${rvT} `
            );

            const complexRVal = this.decode(rvalue, state);

            if (lvalue instanceof BaseMemoryView) {
                lvalue.encode(complexRVal, state.memory, state.memAllocator);
            } else if (lvalue instanceof BaseStorageView) {
                state.storage = lvalue.encode(complexRVal, state.storage);
            } else {
                const memView = PointerMemView.allocMemFor(
                    complexRVal,
                    lvalue.type.to,
                    state.memAllocator
                );
                memView.encode(complexRVal, state.memory, state.memAllocator);
                lvalue.encode(memView);
            }

            return;
        }

        // In all other cases we are either:
        // 1. assigning a primitive value,
        // 2. assigning memory-to-memory (which aliases),
        // 3. assigning to a local pointer a reference of the same type (which aliases)
        if (lvalue instanceof BaseStorageView) {
            state.storage = lvalue.encode(rvalue, state.storage);
        } else if (lvalue instanceof BaseMemoryView) {
            lvalue.encode(rvalue, state.memory, state.memAllocator);
        } else if (lvalue instanceof BaseLocalView) {
            this.expect(
                !(lvalue.type instanceof sol.PointerType) ||
                    isPoison(rvalue) ||
                    (rvalue instanceof View && lvalue.type.to.pp() === rvalue.type.pp())
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
            const lType = this._infer.typeOf(expr.vLeftHandSide);
            // @todo Need to detect userdefined function manually here! The AST doesn't give us a this like a BinaryOperation would

            rvalue = this.computeBinary(lVal, op, rvalue, lType, undefined, this.isUnchecked(expr));
            this.assign(lv, rvalue, state);
        } else {
            this.assign(lv, rvalue, state);
        }

        // @todo do we return lvalue or rvalue here?
        return rvalue;
    }

    private clamp(val: bigint, type: sol.TypeNode, unchecked: boolean): bigint {
        const clampedVal = type instanceof sol.IntType ? sol.clampIntToType(val, type) : val;
        const overflow = clampedVal !== val;

        if (overflow && !unchecked) {
            this.runtimeError(Overflow, ``);
        }

        return clampedVal;
    }

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
            return [left, bigIntToBytes(right)];
        }

        this.fail(InterpError, `Unexpected values ${ppValue(left)} and ${ppValue(right)}`);
    }

    private computeBinary(
        left: Value,
        operator: string,
        right: Value,
        type: sol.TypeNode,
        userFunction: sol.FunctionDefinition | undefined,
        unchecked: boolean
    ): NonPoisonValue {
        // @todo - need to detect
        if (userFunction) {
            nyi("User-defined operators");
        }

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

            [left, right] = this.coerceIntLiteralsToBytes(left, right);

            if (typeof left === "boolean" && typeof right === "boolean") {
                isEqual = left === right;
            } else if (typeof left === "bigint" && typeof right === "bigint") {
                isEqual = left === right;
            } else if (left instanceof Uint8Array && right instanceof Uint8Array) {
                isEqual = equalsBytes(left, right);
            } else {
                nyi(`${left} ${operator} ${right}`);
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
            let [sleft, sright]: [any, any] = this.coerceIntLiteralsToBytes(left, right);

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
                return left < right;
            }

            if (operator === "<=") {
                return left <= right;
            }

            if (operator === ">") {
                return left > right;
            }

            if (operator === ">=") {
                return left >= right;
            }

            nyi(`Unknown comparison operator ${operator}`);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Arithmetic.includes(operator)) {
            this.expect(typeof left === "bigint" && typeof right === "bigint");
            let res: bigint;

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

            return this.clamp(res, type, unchecked);
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

            [left, right] = this.coerceIntLiteralsToBytes(left, right);

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
        // Note: RHS evaluates first.
        const rVal = this.evalNP(expr.vRightExpression, state);
        const lVal = this.evalNP(expr.vLeftExpression, state);

        return this.computeBinary(
            lVal,
            expr.operator,
            rVal,
            this._infer.typeOf(expr),
            expr.vUserFunction,
            this.isUnchecked(expr)
        );
    }

    evalConditional(expr: sol.Conditional, state: State): Value {
        const cVal = this.evalT(expr.vCondition, Boolean, state);

        return this.eval(cVal ? expr.vTrueExpression : expr.vFalseExpression, state);
    }

    evalElementaryTypeNameExpression(expr: sol.ElementaryTypeNameExpression, state: State): Value {
        nyi(`evalElementaryTypeNameExpression(${expr}, ${state})`);
    }

    /**
     * Type conversion is complex and changes with language versions.
     */
    evalTypeConversion(expr: sol.FunctionCall, state: State): Value {
        this.expect(expr.vArguments.length === 1, `Type conversion expects a single argument`);
        const calleeT = this._infer.typeOf(expr.vExpression);
        this.expect(
            calleeT instanceof sol.TypeNameType,
            `Unexpected type for ${expr.vExpression.print()} in type conversion: ${calleeT.pp()}`
        );

        const fromT = this._infer.typeOf(expr.vArguments[0]);
        const toT = calleeT.type;

        const fromV = this.evalNP(expr.vArguments[0], state);

        // int -> fixed bytes
        if (fromT instanceof sol.IntType && toT instanceof sol.FixedBytesType) {
            this.expect(typeof fromV === "bigint", `Expected a bigint`);
            this.expect(
                fromT.nBits / 8 === toT.size,
                `Unexpected cast from ${fromT.pp()} to ${toT.pp()}`
            );

            scratchWord.fill(0);
            const view = new IntMemView(fromT, 0n);
            view.encode(fromV, scratchWord);

            return scratchWord.slice(32 - toT.size, 32);
        }

        // int literal -> fixed bytes
        if (fromT instanceof sol.IntLiteralType && toT instanceof sol.FixedBytesType) {
            this.expect(typeof fromV === "bigint", `Expected a bigint`);

            scratchWord.fill(0);
            const view = new IntMemView(new sol.IntType(toT.size * 8, false), 0n);
            view.encode(fromV, scratchWord);

            return scratchWord.slice(32 - toT.size, 32);
        }

        if (fromT instanceof sol.IntLiteralType && toT instanceof sol.IntType) {
            this.expect(typeof fromV === "bigint", `Expected a bigint`);
            // In Solidity <0.8.0 coercing int literals that didn't fit resulted in silent overflow.
            // In >0.8.0 its a type error, so we shouldn't encouter it.
            return this.clamp(fromV, toT, lt(this.compilerVersion, "0.8.0"));
        }

        // string ptr -> bytes
        if (
            fromT instanceof sol.PointerType &&
            fromT.to instanceof sol.StringType &&
            toT instanceof sol.BytesType
        ) {
            this.expect(
                fromV instanceof View && fromV.type instanceof sol.StringType,
                `Expected string pointer not ${ppValue(fromV)}`
            );
            if (fromV instanceof StringMemView) {
                return new BytesMemView(new sol.BytesType(), fromV.offset);
            } else if (fromV instanceof StringCalldataView) {
                return new BytesCalldataView(new sol.BytesType(), fromV.offset, fromV.base);
            } else if (fromV instanceof StringStorageView) {
                return new BytesStorageView(new sol.BytesType(), [
                    fromV.key,
                    fromV.endOffsetInWord
                ]);
            }
        }

        nyi(`evalTypeConversion ${fromT.pp()} -> ${toT.pp()}`);
    }

    detectStructFieldExprs(
        expr: sol.FunctionCall,
        struct: ExpStructType
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
                let fieldT: sol.TypeNode;

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
    evalStructConstructorCall(expr: sol.FunctionCall, state: State): Value {
        const calleeT = this._infer.typeOf(expr.vExpression);

        this.expect(
            calleeT instanceof sol.TypeNameType &&
                calleeT.type instanceof sol.UserDefinedType &&
                calleeT.type.definition instanceof sol.StructDefinition,
            `Expected UserDefinedTypeName not ${calleeT.pp()}`
        );

        const structT = simplifyType(
            calleeT.type,
            this._infer,
            sol.DataLocation.Memory
        ) as ExpStructType;
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

    evalBuiltinCall(expr: sol.FunctionCall, state: State): Value {
        const callee = this.evalNP(expr.vExpression, state);
        const args: Value[] = expr.vArguments.map((argExpr) => this.evalNP(argExpr, state));
        const argTs: sol.TypeNode[] = expr.vArguments.map((argExpr) => this._infer.typeOf(argExpr));

        this.expect(callee instanceof BuiltinFunction);

        if (callee.implicitFirstArg) {
            this.expect(
                expr.vExpression instanceof sol.MemberAccess,
                `Expected member access in builtin callee ${printNode(expr)}`
            );

            const savedTrace = this._trace;
            // Small hack - we don't want to add to the trace the re-evaluation of the base
            this._trace = [];
            const firstArg = this.eval(expr.vExpression.vExpression, state);
            this._trace = savedTrace;

            args.unshift(firstArg);
            argTs.unshift(this._infer.typeOf(expr.vExpression.vExpression));
        }

        const results = this._execCall(callee, args, argTs, state);

        if (results.length === 0) {
            return none;
        }

        if (results.length === 1) {
            return results[0];
        }

        return results;
    }

    evalExternalCall(expr: sol.FunctionCall, state: State): Value {
        nyi(`evalExternalCall(${printNode(expr)}, ${state})`);
    }

    resolveCallee(
        target: sol.FunctionDefinition | sol.ModifierDefinition,
        state: State
    ): sol.FunctionDefinition | sol.VariableDeclaration | sol.ModifierDefinition {
        if (target instanceof sol.FunctionDefinition && !isMethod(target)) {
            return target;
        }

        this.expect(state.mdc !== undefined);
        const res = sol.resolve(state.mdc, target, this._infer);
        this.expect(
            res !== undefined,
            `Couldn't resolve ${target.name} in contract ${state.mdc.name}`
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
        argTs: sol.TypeNode[],
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
                const argTs = mod.vArguments.map((argE) => this._infer.typeOf(argE));
                this._execCall(mod, argVals, argTs, state);
            } else {
                const resolvedTarget = this.resolveCallee(target, state);
                this.expect(
                    resolvedTarget instanceof sol.FunctionDefinition &&
                        resolvedTarget.vBody !== undefined,
                    `Can't call ${resolvedTarget.name} with no body.`
                );
                this.exec(resolvedTarget.vBody, state);
            }

            res = target.vReturnParameters.vParameters.map((ret, i) => {
                const res = (state.scope as BaseScope).lookup(LocalsScope.returnName(ret, i));
                if (res === undefined) {
                    this.fail(NotDefined, ``);
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
            res = target.call(this, state, args.length);
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

    evalInternalCall(expr: sol.FunctionCall, state: State): Value {
        const calleeAst = this.getCallee(expr.vExpression);
        this.expect(
            calleeAst instanceof sol.Identifier || calleeAst instanceof sol.MemberAccess,
            `Unexpected callee ${printNode(calleeAst)}`
        );
        const def = calleeAst.vReferencedDeclaration;
        this.expect(
            def instanceof sol.FunctionDefinition || def instanceof sol.VariableDeclaration,
            `Unexpected callee def ${def}`
        );

        this.expect(
            state.mdc !== undefined,
            `NYI calling a global function from another global function`
        );
        const resolvedCalleeDef = isMethod(def) ? sol.resolve(state.mdc, def, this._infer) : def;
        this.expect(
            resolvedCalleeDef !== undefined,
            `Couldn't resolve callee ${def.name} in contract ${state.mdc}`
        );

        const argVals = expr.vArguments.map((arg) => this.eval(arg, state));
        const argTs = expr.vArguments.map((arg) => this._infer.typeOf(arg));
        let results: Value[];

        if (resolvedCalleeDef instanceof sol.FunctionDefinition) {
            results = this._execCall(resolvedCalleeDef, argVals, argTs, state);
        } else {
            nyi(`Calling public getter ${resolvedCalleeDef.name} in ${state.mdc}`);
        }

        if (results.length === 0) {
            return none;
        }

        if (results.length === 1) {
            return results[0];
        }

        return results;
    }

    evalNewCall(expr: sol.FunctionCall, state: State): Value {
        const calleeAST = this.getCallee(expr.vExpression) as sol.NewExpression;
        const newT = this._infer.typeNameToSpecializedTypeNode(
            calleeAST.vTypeName,
            sol.DataLocation.Memory
        );

        const args = expr.vArguments.map((arg) => this.eval(arg, state));

        if (
            newT instanceof sol.UserDefinedType &&
            newT.definition instanceof sol.ContractDefinition
        ) {
            // new contract
            nyi(`Creating a new contract`);
        }

        let simplifiedT = simplifyType(newT, this._infer, sol.DataLocation.Memory);
        this.expect(simplifiedT instanceof sol.PointerType, ``);
        simplifiedT = simplifiedT.to;
        this.expect(
            (simplifiedT instanceof sol.ArrayType || simplifiedT instanceof sol.PackedArrayType) &&
                args.length === 1 &&
                typeof args[0] === "bigint",
            `Expected an array type with a single length argument not ${simplifiedT.pp()} with ${args}`
        );

        const arrSize = bigIntToNum(args[0], 0n, MAX_ARR_DECODE_LIMIT);

        let initialVal: BaseValue;
        let addr: bigint;

        if (simplifiedT instanceof sol.ArrayType) {
            initialVal = [];

            for (let i = 0; i < arrSize; i++) {
                initialVal.push(makeZeroValue(simplifiedT.elementT, state));
            }

            addr = state.memAllocator.alloc(32 * arrSize + 32);
        } else {
            initialVal =
                simplifiedT instanceof sol.BytesType
                    ? new Uint8Array(arrSize)
                    : `\x00`.repeat(arrSize);
            addr = state.memAllocator.alloc(arrSize + 32);
        }
        const view = makeMemoryView(simplifiedT, addr);
        view.encode(initialVal, state.memory, state.memAllocator);

        return view;
    }

    /**
     * Helper to get the callee from a FunctionCall.vExpression. This strips gas,value, salt modifiers.
     * @todo replace this with decodeCallee to get the gas, value and salt
     */
    private getCallee(expr: sol.Expression): sol.Expression {
        while (expr instanceof sol.FunctionCallOptions || expr instanceof sol.FunctionCall) {
            expr = expr.vExpression;
        }

        return expr;
    }

    evalFunctionCall(expr: sol.FunctionCall, state: State): Value {
        if (expr.kind === sol.FunctionCallKind.TypeConversion) {
            return this.evalTypeConversion(expr, state);
        }

        if (expr.kind === sol.FunctionCallKind.StructConstructorCall) {
            return this.evalStructConstructorCall(expr, state);
        }

        if (expr.vFunctionCallType === sol.ExternalReferenceType.Builtin) {
            const calleeAst = this.getCallee(expr.vExpression);

            if (calleeAst instanceof sol.NewExpression) {
                return this.evalNewCall(expr, state);
            }

            return this.evalBuiltinCall(expr, state);
        }

        if (this._infer.isFunctionCallExternal(expr)) {
            return this.evalExternalCall(expr, state);
        }

        return this.evalInternalCall(expr, state);
    }

    evalIdentifier(expr: sol.Identifier, state: State): Value {
        // contract name
        if (expr.vReferencedDeclaration instanceof sol.ContractDefinition) {
            return new DefValue(expr.vReferencedDeclaration);
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
        const baseT = this._infer.typeOf(expr.vBaseExpression);

        let baseVal = this.evalNP(expr.vBaseExpression, state);
        const indexVal = this.evalNP(expr.vIndexExpression, state);

        let res: Value;

        if (isPointerView(baseVal)) {
            baseVal = this.deref(baseVal, state);
        }

        if (isArrayLikeView(baseVal)) {
            this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);
            if (isArrayLikeMemView(baseVal)) {
                res = baseVal.indexView(indexVal, state.memory);
            } else if (isArrayLikeCalldataView(baseVal)) {
                res = baseVal.indexView(indexVal, getMsg(state));
            } else if (isArrayLikeStorageView(baseVal)) {
                res = baseVal.indexView(indexVal, state.storage);
            } else {
                nyi(`Array like view ${baseVal.constructor.name}`);
            }

            // @todo make this condition more specific by adding an OoB subclass of DecodingFailure in sol-dbg
            if (res instanceof Poison) {
                throw new OOB(expr, this._trace);
            }

            res = this.lvToValue(res, state);
        } else if (baseVal instanceof Uint8Array) {
            this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);
            this.expect(
                baseT instanceof sol.FixedBytesType,
                `Expected a stack fixed byte var in base index`
            );

            if (indexVal < 0n || indexVal >= baseT.size) {
                this.runtimeError(OOB, ``);
            }

            res = BigInt(baseVal[Number(indexVal)]);
        } else if (baseVal instanceof MapStorageView) {
            const key =
                indexVal instanceof View
                    ? this.decode(indexVal, state)
                    : (indexVal as PrimitiveValue);
            const idxView = baseVal.indexView(key);
            res = this.lvToValue(idxView, state);
        } else {
            nyi(`Index access base ${baseVal}`);
        }

        if (res instanceof DecodingFailure) {
            this.runtimeError(OOB, ``);
        }

        // @todo add test for order of operations
        return res;
    }

    evalIndexRangeAccess(expr: sol.IndexRangeAccess, state: State): Value {
        nyi(`evalIndexRangeAccess(${printNode(expr)}, ${state})`);
    }

    evalLiteral(expr: sol.Literal, state: State): Value {
        if (expr.kind === sol.LiteralKind.Number) {
            return BigInt(expr.value);
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

    evalMemberAccess(expr: sol.MemberAccess, state: State): Value {
        let baseVal = this.evalNP(expr.vExpression, state);

        if (isPointerView(baseVal)) {
            baseVal = this.deref(baseVal, state);
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
            const field = baseVal.fields.filter(([name]) => name === expr.memberName);
            this.expect(field.length === 1, `Unknown field ${expr.memberName}`);
            return field[0][1];
        }

        if (isArrayLikeView(baseVal) && expr.memberName === "length") {
            return this.getSize(baseVal, state);
        }

        if (baseVal instanceof DefValue) {
            if (
                baseVal.def instanceof sol.EventDefinition ||
                baseVal.def instanceof sol.ErrorDefinition
            ) {
                return hexToBytes(`0x${this._infer.signatureHash(baseVal.def)}`);
            }

            if (
                baseVal.def instanceof sol.SourceUnit ||
                baseVal.def instanceof sol.ContractDefinition
            ) {
                const scope = this.makeStaticScope(baseVal.def, state);
                const res = scope.lookup(expr.memberName);
                this.expect(
                    res !== undefined,
                    `Couldnt find ${expr.memberName} in ${ppValue(baseVal)}`
                );

                return res;
            }
        }

        if (
            (isArrayLikeStorageView(baseVal) && expr.memberName === "push") ||
            expr.memberName === "pop"
        ) {
            return expr.memberName === "push" ? pushBuiltin : popBuiltin;
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
            const arrPtrT = this._infer.typeOf(expr);
            this.expect(
                arrPtrT instanceof sol.PointerType &&
                    arrPtrT.to instanceof sol.ArrayType &&
                    arrPtrT.to.size !== undefined,
                `Expected a fixed size array in memory not ${arrPtrT.pp()}`
            );

            const arrView = PointerMemView.allocMemFor(undefined, arrPtrT.to, state.memAllocator);
            this.expect(arrView instanceof ArrayMemView, ``);

            for (let i = 0n; i < arrPtrT.to.size; i++) {
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
     * Given a view decode its contents. Note that this may return complex values.
     */
    public decode(lv: View, state: State): BaseValue {
        if (lv instanceof BaseStorageView) {
            return lv.decode(state.storage);
        } else if (lv instanceof BaseMemoryView) {
            return lv.decode(state.memory);
        } else if (lv instanceof BaseCalldataView) {
            return lv.decode(getMsg(state));
        } else if (lv instanceof PrimitiveLocalView) {
            return lv.decode();
        }

        nyi(`decode(${lv})`);
    }

    /**
     * Given an array-like view get its size
     */
    public getSize(lv: ArrayLikeView<any, View>, state: State): bigint {
        let res: bigint | DecodingFailure;
        if (isArrayLikeStorageView(lv)) {
            res = lv.size(state.storage);
        } else if (isArrayLikeMemView(lv)) {
            res = lv.size(state.memory);
        } else if (isArrayLikeCalldataView(lv)) {
            res = lv.size(getMsg(state));
        } else if (lv instanceof ArrayLikeLocalView) {
            res = lv.size();
        } else {
            nyi(`getSize(${lv})`);
        }

        this.expect(typeof res === "bigint", `Error getting the size of ${lv}`);
        return res;
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
                return this.decode(lv, state) as PrimitiveValue;
            }

            if (isPointerView(lv)) {
                return this.deref(lv, state);
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
        const t = this._infer.typeOf(expr);

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

            const newVal = expr.operator === "++" ? subVal + 1n : subVal - 1n;
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

        return this.clamp(res, t, unchecked);
    }

    makeBuiltinScope(state: State): BuiltinsScope {
        const builtins = [assertBuiltin];
        return new BuiltinsScope(
            builtins.map((b) => [b.name, b.type, b]),
            state,
            undefined
        );
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
            return this.makeBuiltinScope(state);
        }

        while (nd !== undefined) {
            if (nd instanceof sol.SourceUnit || nd instanceof sol.ContractDefinition) {
                scopeNodes.push(nd);
            }

            nd = nd.parent;
        }

        scopeNodes.reverse();
        let scope: BaseScope = this.makeBuiltinScope(state);

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
        argTs: sol.TypeNode[],
        state: State
    ): BaseScope {
        const staticScope = this.makeStaticScope(nd, state);
        let localNames: string[];

        if (nd instanceof BuiltinFunction) {
            nd = nd.concretize(argTs);
        }

        if (nd instanceof BuiltinFunction) {
            localNames = nd.type.parameters.map((_, i) => `arg_${i}`);
        } else {
            localNames = nd.vParameters.vParameters.map((d) => d.name);
        }

        // We keep the returns in the function scope as well
        if (nd instanceof sol.FunctionDefinition) {
            localNames.push(
                ...nd.vReturnParameters.vParameters.map((ret, i) => LocalsScope.returnName(ret, i))
            );
            args.push(
                ...nd.vReturnParameters.vParameters.map((ret) => {
                    const type = simplifyType(
                        this._infer.variableDeclarationToTypeNode(ret),
                        this._infer,
                        undefined
                    );
                    return makeZeroValue(type, state);
                })
            );
        }

        sol.assert(
            localNames.length === args.length,
            `Mismatch in args in call to ${nd.name} expected ${localNames.length} got ${args.length}`
        );

        const res = new LocalsScope(nd, state, this.compilerVersion, staticScope);

        for (let i = 0; i < localNames.length; i++) {
            const v = res.lookupLocation(localNames[i]);
            this.expect(v !== undefined, ``);
            this.assign(v, args[i], state);
        }

        return res;
    }

    /**
     * Make an empty state containing just the constants
     * @returns
     */
    public makeState(): State {
        const memAllocator = new DefaultAllocator();
        const [constantsMap, constantsMemory] = this.artifactManager.getConstants(this.artifact);

        // Copy over the constants into the new memory
        memAllocator.alloc(constantsMemory.length);
        memAllocator.memory.set(constantsMemory, 0x80);

        return {
            storage: ImmMap.fromEntries([]),
            memory: memAllocator.memory,
            memAllocator,
            mdc: undefined,
            msg: {
                to: ZERO_ADDRESS,
                data: new Uint8Array(),
                gas: 0n,
                value: 0n,
                salt: undefined
            },
            intCallStack: [],
            scope: undefined,
            constantsMap: constantsMap
        };
    }
}
