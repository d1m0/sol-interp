import {
    ArtifactManager,
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
    zip,
    Value as BaseValue
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import { WorldInterface, State, SolMessage } from "./state";
import { EvalStep, ExecStep, Trace } from "./step";
import { InterpError, NoScope, OOB, Overflow } from "./exceptions";
import { gte, lt } from "semver";
import { BuiltinFunction, isPrimitiveValue, LValue, none, NoneValue, Value } from "./value";
import { Address } from "@ethereumjs/util";
import { BaseScope, LocalsScope } from "./scope";
import { getMsg, isValueType, makeZeroValue } from "./utils";
import { BaseStorageView, BaseMemoryView, BaseCalldataView } from "sol-dbg";
import {
    BaseLocalView,
    ArrayLikeLocalView,
    isArrayLikeView,
    isPointerView,
    PointerLocalView,
    PrimitiveLocalView
} from "./view";

enum ControlFlow {
    Fallthrough = 0,
    Break = 1,
    Continue = 2,
    Return = 3
}

const scratchWord = new Uint8Array(32);

/**
 * Solidity Interpeter class. Includes the following entrypoint
 *
 * * evaluate a single expression
 *      `eval(expr: sol.Expression, state: State): [Trace, Value]`
 * * execute one statement
 *      @todo
 * * call an internal function
 *      @todo
 * * call an external method
 */
export class Interpreter {
    constructor(
        protected readonly world: WorldInterface,
        protected readonly artifactManager: ArtifactManager
    ) {}

    ///*********************EXTERNAL FUNCTION CALLS************************************
    public create(msg: SolMessage, state: State): [Trace, Address] {
        nyi(`create`);
    }

    public call(msg: SolMessage, state: State): [Trace, Value[] | InterpError] {
        nyi(`create`);
    }

    private pushScope(node: sol.ASTNode, vals: Array<[string, Value]>, state: State): void {
        if (
            node instanceof sol.FunctionDefinition ||
            node instanceof sol.ModifierDefinition ||
            node instanceof sol.Block ||
            node instanceof sol.UncheckedBlock ||
            node instanceof sol.VariableDeclarationStatement
        ) {
            const scopeStore = new Map<string, Value>();
            state.localsStack.push(scopeStore);
            const newScope = new LocalsScope(node, state, state.scope);

            // Add arguments to store
            for (const [name, val] of vals) {
                newScope.set(name, val);
            }

            state.scope = newScope;

            return;
        }

        nyi(`Scope node ${node.print(0)}`);
    }

    private popScope(state: State): void {
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
        state: State
    ): [Trace, Value[]] {
        // @todo handle modifiers!!!!!
        const formalArgs: sol.VariableDeclaration[] = callee.vParameters.vParameters;

        // Zero-init return values if they are named
        const infer = this.infer(state);
        const formalReturns = callee.vReturnParameters.vParameters;
        const retVals = formalReturns.map((ret) =>
            makeZeroValue(infer.variableDeclarationToTypeNode(ret), state)
        );

        const argRetNames = [
            ...formalArgs.map((d) => d.name),
            ...formalReturns.map((ret, i) => LocalsScope.returnName(ret, i))
        ];
        const argRetVals = [...args, ...retVals];

        // Add function scope (includes arguments and returns)
        this.pushScope(callee, zip(argRetNames, argRetVals), state);

        sol.assert(callee.vBody !== undefined, `Can't call function with no body ${callee.name}`);
        const [trace, flow] = this.exec(callee.vBody, state);
        sol.assert(
            flow === ControlFlow.Fallthrough || flow === ControlFlow.Return,
            `Unexpected control flow at end of function ${flow}`
        );

        const results = formalReturns.map((ret, i) =>
            (state.scope as BaseScope).lookup(ret.name === "" ? `<ret_${i}>` : ret.name)
        );
        return [trace, results];
    }

    ///*********************STATEMENTS*************************************************
    public exec(stmt: sol.Statement, state: State): [Trace, ControlFlow] {
        let trace: Trace;
        let res: ControlFlow;

        if (stmt instanceof sol.Block || stmt instanceof sol.UncheckedBlock) {
            [trace, res] = this.execBlock(stmt, state);
        } else if (stmt instanceof sol.ExpressionStatement) {
            [trace, res] = this.execExpressionStatement(stmt, state);
        } else if (stmt instanceof sol.VariableDeclarationStatement) {
            [trace, res] = this.execVariableDeclarationStatement(stmt, state);
        } else if (stmt instanceof sol.Return) {
            [trace, res] = this.execReturn(stmt, state);
            /*
        } else if (stmt instanceof sol.Break) {
            [trace, res] = this.execBreak(stmt, state);
        } else if (stmt instanceof sol.Continue) {
            [trace, res] = this.execContinue(stmt, state);
        } else if (stmt instanceof sol.DoWhileStatement) {
            [trace, res] = this.execDoWhileStatement(stmt, state);
        } else if (stmt instanceof sol.EmitStatement) {
            [trace, res] = this.execEmitStatement(stmt, state);
        } else if (stmt instanceof sol.ForStatement) {
            [trace, res] = this.execForStatement(stmt, state);
        } else if (stmt instanceof sol.IfStatement) {
            [trace, res] = this.execIfStatement(stmt, state);
        } else if (stmt instanceof sol.InlineAssembly) {
            [trace, res] = this.execInlineAssembly(stmt, state);
        } else if (stmt instanceof sol.PlaceholderStatement) {
            [trace, res] = this.execPlaceholderStatement(stmt, state);
        } else if (stmt instanceof sol.RevertStatement) {
            [trace, res] = this.execRevertStatement(stmt, state);
        } else if (stmt instanceof sol.Throw) {
            [trace, res] = this.execThrow(stmt, state);
        } else if (stmt instanceof sol.TryCatchClause) {
            [trace, res] = this.execTryCatchClause(stmt, state);
        } else if (stmt instanceof sol.TryStatement) {
            [trace, res] = this.execTryStatement(stmt, state);
        } else if (stmt instanceof sol.WhileStatement) {
            [trace, res] = this.execWhileStatement(stmt, state);
            */
        } else {
            nyi(`Stmt ${stmt.constructor.name}`);
        }

        trace.push(new ExecStep(stmt));

        return [trace, res];
    }

    private execVariableDeclarationStatement(
        stmt: sol.VariableDeclarationStatement,
        state: State
    ): [Trace, ControlFlow] {
        const trace: Trace = [];
        let varInitialVals: Value[] = [];
        const infer = this.infer(state);

        if (stmt.vInitialValue) {
            const [initVT, initVal] = this.eval(stmt.vInitialValue, state);

            trace.push(...initVT);
            varInitialVals =
                stmt.vInitialValue instanceof sol.TupleExpression &&
                stmt.vInitialValue.vOriginalComponents.length > 1
                    ? (initVal as Value[])
                    : [initVal];
        } else {
            varInitialVals = stmt.vDeclarations.map((d) =>
                makeZeroValue(infer.variableDeclarationToTypeNode(d), state)
            );
        }

        if (gte(state.version, "0.5.0")) {
            const vals: Array<[string, Value]> = [];

            for (let i = 0, j = 0; i < stmt.assignments.length; i++) {
                if (stmt.assignments[i] === null) {
                    continue;
                }

                vals.push([stmt.vDeclarations[j].name, varInitialVals[i]]);
                j++;
            }

            this.pushScope(stmt, vals, state);
        } else {
            for (let i = 0; i < stmt.vDeclarations.length; i++) {
                const decl = stmt.vDeclarations[i];
                const val = varInitialVals[i];

                sol.assert(state.scope !== undefined, `Missing scope`);

                if (!(val instanceof NoneValue)) {
                    state.scope.set(decl.name, val);
                }
            }
        }

        return [trace, ControlFlow.Fallthrough];
    }

    private execExpressionStatement(
        stmt: sol.ExpressionStatement,
        state: State
    ): [Trace, ControlFlow] {
        // I think (?) the only things that can break control flow are statements (break, continue, return)
        // Note that exceptions (revert, assert...) are also handled in the interpreter by raising an exception and handling
        // it at the last external call site
        const [trace] = this.eval(stmt.vExpression, state);
        return [trace, ControlFlow.Fallthrough];
    }

    private execBlock(block: sol.Block | sol.UncheckedBlock, state: State): [Trace, ControlFlow] {
        const trace: Trace = [];
        let flow: ControlFlow = ControlFlow.Fallthrough;

        this.pushScope(block, [], state);

        for (const stmt of block.vStatements) {
            let stmtTrace;
            [stmtTrace, flow] = this.exec(stmt, state);

            trace.push(...stmtTrace);

            if (flow !== ControlFlow.Fallthrough) {
                break;
            }
        }

        if (gte(state.version, "0.5.0")) {
            // In Solidity >0.5.0 all variable declaration statements in the block are their own scopes, that go out of scope at the end
            // of the block. So remove them here
            while (!(state.scope instanceof LocalsScope && state.scope.node === block)) {
                this.popScope(state);
            }
        }

        this.popScope(state);
        return [trace, flow];
    }

    private execReturn(stmt: sol.Return, state: State): [Trace, ControlFlow] {
        sol.assert(state.scope !== undefined, ``);
        let trace: Trace = [];
        let retVals: Value[] = [];

        if (stmt.vExpression) {
            let retVal: Value;

            [trace, retVal] = this.eval(stmt.vExpression, state);
            retVals =
                stmt.vExpression instanceof sol.TupleExpression ? (retVal as Value[]) : [retVal];
        } else {
            retVals = [];
        }

        const fun = stmt.getClosestParentByType(sol.FunctionDefinition);

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

        return [trace, ControlFlow.Return];
    }

    ///*********************EXPRESSIONS************************************************
    /**
     * Evaluate a single expression in a given state. Return a trace of the
     * evaluation and the resulting value.
     */
    public eval(expr: sol.Expression, state: State): [Trace, Value] {
        let trace: Trace;
        let res: Value;

        if (expr instanceof sol.Assignment) {
            [trace, res] = this.evalAssignment(expr, state);
        } else if (expr instanceof sol.BinaryOperation) {
            [trace, res] = this.evalBinaryOperation(expr, state);
        } else if (expr instanceof sol.Conditional) {
            [trace, res] = this.evalConditional(expr, state);
        } else if (expr instanceof sol.ElementaryTypeNameExpression) {
            [trace, res] = this.evalElementaryTypeNameExpression(expr, state);
        } else if (expr instanceof sol.FunctionCall) {
            [trace, res] = this.evalFunctionCall(expr, state);
        } else if (expr instanceof sol.Identifier) {
            [trace, res] = this.evalIdentifier(expr, state);
        } else if (expr instanceof sol.IndexAccess) {
            [trace, res] = this.evalIndexAccess(expr, state);
        } else if (expr instanceof sol.IndexRangeAccess) {
            [trace, res] = this.evalIndexRangeAccess(expr, state);
        } else if (expr instanceof sol.Literal) {
            [trace, res] = this.evalLiteral(expr, state);
        } else if (expr instanceof sol.MemberAccess) {
            [trace, res] = this.evalMemberAccess(expr, state);
        } else if (expr instanceof sol.TupleExpression) {
            [trace, res] = this.evalTupleExpression(expr, state);
        } else if (expr instanceof sol.UnaryOperation) {
            [trace, res] = this.evalUnaryOperation(expr, state);
        } else {
            nyi(`evalExpression(${expr.constructor.name})`);
        }

        if (res instanceof View && isValueType(res.type)) {
            res = this.lvToValue(res, state);
        }

        if (res instanceof Poison) {
            throw new InterpError(`Eval-ed poison while evaluating ${expr.print()}: ${res}`);
        }

        trace.push(new EvalStep(expr, res));

        return [trace, res];
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
            throw new InterpError(`Couldn't deref pointer view ${v}`);
        }

        return res;
    }

    evalLV(expr: sol.Expression, state: State): [Trace, LValue] {
        if (expr instanceof sol.Identifier) {
            sol.assert(state.scope !== undefined, `Missing scope in evalLV({0})`, expr);
            const lv = state.scope.lookupLocation(expr.name);
            return [[new EvalStep(expr, lv)], lv];
        }

        if (expr instanceof sol.TupleExpression) {
            const trace: Trace = [];
            const lvs: LValue[] = [];
            for (const comp of expr.vOriginalComponents) {
                if (comp === null) {
                    lvs.push(null);
                    continue;
                }

                const [compTrace, compVal] = this.evalLV(comp, state);
                trace.push(...compTrace);
                lvs.push(compVal);
            }

            trace.push(new EvalStep(expr, lvs));

            return [trace, lvs.length === 1 ? lvs[0] : lvs];
        }

        if (expr instanceof sol.IndexAccess) {
            this.expect(
                expr.vIndexExpression !== undefined,
                `Missing index expression in ${expr.print()}`
            );

            let [baseTrace, baseLV] = this.evalLV(expr.vBaseExpression, state);
            // Note that the index expression of an LValue is not itself an LValue so we eval it.
            const [idxTrace, indexVal] = this.eval(expr.vIndexExpression, state);

            this.expect(
                baseLV instanceof View,
                `Expected IndexAccess LValue ${expr.print()} to evaluate to a view, not ${baseLV}`
            );

            // @todo replace with isPointerView
            if (isPointerView(baseLV)) {
                baseLV = this.deref(baseLV, state);
            }

            let res: LValue | DecodingFailure;

            if (isArrayLikeView(baseLV)) {
                this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);

                if (isArrayLikeMemView(baseLV)) {
                    res = baseLV.indexView(indexVal, state.memory);
                } else if (isArrayLikeCalldataView(baseLV)) {
                    res = baseLV.indexView(indexVal, getMsg(state));
                } else if (isArrayLikeStorageView(baseLV)) {
                    res = baseLV.indexView(indexVal, state.storage);
                } else if (baseLV instanceof ArrayLikeLocalView) {
                    res = baseLV.indexView(indexVal, state.storage);
                } else {
                    nyi(`Unkown ArrayLikeView ${baseLV.constructor.name}`);
                }
            } else {
                nyi(`Index access base ${baseLV}`);
            }

            if (res instanceof DecodingFailure) {
                throw new InterpError(`Failed decoding index LValue in ${expr.print()}`);
            }

            return [[...baseTrace, ...idxTrace, new EvalStep(expr, res)], res];
        }

        nyi(`evalLV(${expr.print()})`);
    }

    assign(lvalue: LValue, rvalue: Value, state: State): void {
        if (lvalue instanceof BaseStorageView) {
            state.storage = lvalue.encode(rvalue, state.storage);
        } else if (lvalue instanceof BaseMemoryView) {
            lvalue.encode(rvalue, state.memory, state.allocator);
        } else if (lvalue instanceof Array) {
            this.expect(
                rvalue instanceof Array && rvalue.length === lvalue.length,
                `Mismatch in tuple assignment`
            );

            for (let i = 0; i < lvalue.length; i++) {
                this.assign(lvalue[i], rvalue[i], state);
            }
        } else if (lvalue instanceof BaseLocalView) {
            this.expect(
                isPrimitiveValue(rvalue),
                `Unexpected value ${rvalue} in assignment to local ${lvalue.name}`
            );
            lvalue.encode(rvalue);
        } else if (lvalue === null) {
            // Nothing to do - missing component in the LHS of a tuple assignment.
        } else {
            nyi(`assign(${lvalue}, ${rvalue}, ${state})`);
        }
    }

    evalAssignment(expr: sol.Assignment, state: State): [Trace, Value] {
        let rtrace;
        let rvalue;

        [rtrace, rvalue] = this.eval(expr.vRightHandSide, state);
        const [ltrace, lv] = this.evalLV(expr.vLeftHandSide, state);

        // @todo handle coercions
        // @todo handle memory to storage copy
        // @todo handle storage to storage copy assignments
        // @todo after indexaccess is fixed, add a test of the shape a[i++] = i++; and (a[i++], a[i++]) = [1,2]; to see order of evaluation.

        // Assignment with a combined binary operator
        if (expr.operator.length > 1) {
            const op = expr.operator.slice(0, -1);
            const lVal = this.lvToValue(lv, state);
            const lType = this.infer(state).typeOf(expr.vLeftHandSide);
            // @todo Need to detect userdefined function manually here! The AST doesn't give us a this like a BinaryOperation would

            rvalue = this.computeBinary(
                expr,
                lVal,
                op,
                rvalue,
                lType,
                undefined,
                this.isUnchecked(expr, state)
            );
            this.assign(lv, rvalue, state);
        } else {
            this.assign(lv, rvalue, state);
        }

        // @todo do we return lvalue or rvalue here?
        return [[...rtrace, ...ltrace], rvalue];
    }

    private clamp(
        expr: sol.Expression,
        val: bigint,
        type: sol.TypeNode,
        unchecked: boolean
    ): bigint {
        const clampedVal = type instanceof sol.IntType ? sol.clampIntToType(val, type) : val;
        const overflow = clampedVal !== val;

        if (overflow && !unchecked) {
            throw new Overflow(expr);
        }

        return clampedVal;
    }

    private computeBinary(
        expr: sol.Expression,
        left: Value,
        operator: string,
        right: Value,
        type: sol.TypeNode,
        userFunction: sol.FunctionDefinition | undefined,
        unchecked: boolean
    ): Value {
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

            if (typeof left === "boolean" && typeof right === "boolean") {
                isEqual = left === right;
            } else if (typeof left === "bigint" && typeof right === "bigint") {
                isEqual = left === right;
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
            this.expect(typeof left === "bigint" && typeof right === "bigint");
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

            return this.clamp(expr, res, type, unchecked);
        }

        if (sol.BINARY_OPERATOR_GROUPS.Bitwise.includes(operator)) {
            this.expect(typeof left === "bigint" && typeof right === "bigint");

            if (operator === "<<") {
                return left << right;
            }

            if (operator === ">>") {
                return left >> right;
            }

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

        nyi(`${left} ${operator} ${right}`);
    }

    evalBinaryOperation(expr: sol.BinaryOperation, state: State): [Trace, Value] {
        const [lTrace, lVal] = this.eval(expr.vLeftExpression, state);
        const [rTrace, rVal] = this.eval(expr.vRightExpression, state);

        const res = this.computeBinary(
            expr,
            lVal,
            expr.operator,
            rVal,
            this.typeof(expr, state),
            expr.vUserFunction,
            this.isUnchecked(expr, state)
        );

        return [[...lTrace, ...rTrace], res];
    }

    evalConditional(expr: sol.Conditional, state: State): [Trace, Value] {
        const [cTrace, cVal] = this.eval(expr.vCondition, state);

        this.expect(typeof cVal === "boolean", `Condition expected a boolean`);

        const [bTrace, bVal] = this.eval(
            cVal ? expr.vTrueExpression : expr.vFalseExpression,
            state
        );

        return [[...cTrace, bTrace], bVal];
    }

    evalElementaryTypeNameExpression(
        expr: sol.ElementaryTypeNameExpression,
        state: State
    ): [Trace, Value] {
        nyi("");
    }

    /**
     * Type conversion is complex and changes with language versions.
     */
    evalTypeConversion(expr: sol.FunctionCall, state: State): [Trace, Value] {
        const infer = this.infer(state);
        this.expect(expr.vArguments.length === 1, `Type conversion expects a single argument`);
        const calleeT = infer.typeOf(expr.vExpression);
        this.expect(
            calleeT instanceof sol.TypeNameType,
            `Unexpected type for ${expr.vExpression.print()} in type conversion: ${calleeT.pp()}`
        );

        const fromT = infer.typeOf(expr.vArguments[0]);
        const toT = calleeT.type;

        const [fromTrace, fromV] = this.eval(expr.vArguments[0], state);

        if (fromT instanceof sol.IntType && toT instanceof sol.FixedBytesType) {
            this.expect(typeof fromV === "bigint", `Expected a bigint`);
            this.expect(
                fromT.nBits / 8 === toT.size,
                `Unexpected cast from ${fromT.pp()} to ${toT.pp()}`
            );

            scratchWord.fill(0);
            const view = new IntMemView(fromT, 0n);
            view.encode(fromV, scratchWord);

            return [fromTrace, scratchWord.slice(32 - toT.size, 32)];
        }

        nyi(`evalTypeConversion ${fromT.pp()} -> ${toT.pp()}`);
    }

    evalStructConstructorCall(expr: sol.FunctionCall, state: State): [Trace, Value] {
        nyi("");
    }

    evalNewCall(expr: sol.FunctionCall, state: State): [Trace, Value] {
        nyi("");
    }

    /**
     * Helper to get the callee from a FunctionCall.vExpression. This strips gas,value, salt modifiers.
     */
    private getCallee(expr: sol.Expression): sol.Expression {
        while (expr instanceof sol.FunctionCallOptions || expr instanceof sol.FunctionCall) {
            expr = expr.vExpression;
        }

        return expr;
    }

    evalFunctionCall(expr: sol.FunctionCall, state: State): [Trace, Value] {
        if (expr.kind === sol.FunctionCallKind.TypeConversion) {
            return this.evalTypeConversion(expr, state);
        }

        if (expr.kind === sol.FunctionCallKind.StructConstructorCall) {
            return this.evalStructConstructorCall(expr, state);
        }

        const calleeAst = this.getCallee(expr.vExpression);
        // Actual call
        if (
            expr.vFunctionCallType === sol.ExternalReferenceType.Builtin &&
            calleeAst instanceof sol.NewExpression
        ) {
            return this.evalNewCall(expr, state);
        }

        const trace: Trace = [];
        const [calleeTrace, callee] = this.eval(expr.vExpression, state);
        trace.push(...calleeTrace);

        const args: Value[] = [];

        for (const argExpr of expr.vArguments) {
            const [argTrace, argVal] = this.eval(argExpr, state);
            trace.push(...argTrace);
            args.push(argVal);
        }

        if (callee instanceof BuiltinFunction) {
            return [trace, callee.call(state, args)];
        }

        nyi(`Function call ${expr.print()}`);
    }

    evalIdentifier(expr: sol.Identifier, state: State): [Trace, Value] {
        if (!state.scope) {
            throw new NoScope();
        }

        return [[], state.scope.lookup(expr.name)];
    }

    evalIndexAccess(expr: sol.IndexAccess, state: State): [Trace, Value] {
        this.expect(expr.vIndexExpression !== undefined, `Mising index expression in eval`);
        const infer = this.infer(state);

        const baseT = infer.typeOf(expr.vBaseExpression);

        const baseRes = this.eval(expr.vBaseExpression, state);
        const baseTrace = baseRes[0];
        let baseVal = baseRes[1];

        const [indexTrace, indexVal] = this.eval(expr.vIndexExpression, state);

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
            } else  {
                nyi(`Array like view ${baseVal.constructor.name}`)
            }
        } else if (baseVal instanceof Uint8Array) {
            this.expect(typeof indexVal === "bigint", `Expected a bigint for index`);
            this.expect(
                baseT instanceof sol.FixedBytesType,
                `Expected a stack fixed byte var in base index`
            );

            if (indexVal < 0n || indexVal >= baseT.size) {
                throw new OOB(expr);
            }

            res = BigInt(baseVal[Number(indexVal)]);
        } else {
            nyi(`Index access base ${baseVal}`);
        }

        if (res instanceof DecodingFailure) {
            throw new OOB(expr);
        }

        // @todo add test for order of operations
        return [[...baseTrace, ...indexTrace], res];
    }

    evalIndexRangeAccess(expr: sol.IndexRangeAccess, state: State): [Trace, Value] {
        nyi("");
    }

    evalLiteral(expr: sol.Literal, state: State): [Trace, Value] {
        if (expr.kind === sol.LiteralKind.Number) {
            return [[], BigInt(expr.value)];
        }

        if (expr.kind === sol.LiteralKind.Bool) {
            return [[], expr.value === "true"];
        }

        this.expect(expr.kind === sol.LiteralKind.String || expr.kind === sol.LiteralKind.HexString || expr.kind === sol.LiteralKind.UnicodeString);

        const view = state.constantsMap.get(expr.id);
        this.expect(view !== undefined, `Missing string/bytes literal`);
        return [[], view];
    }

    evalMemberAccess(expr: sol.MemberAccess, state: State): [Trace, Value] {
        nyi("");
    }

    evalTupleExpression(expr: sol.TupleExpression, state: State): [Trace, Value] {
        const trace: Trace = [];
        const compVals: Value[] = [];
        for (const comp of expr.vComponents) {
            if (comp === null) {
                compVals.push(none);
            } else {
                const [t, v] = this.eval(comp, state);
                trace.push(...t);
                compVals.push(v);
            }
        }

        if (compVals.length === 0) {
            return [trace, none];
        }

        if (compVals.length === 1) {
            return [trace, compVals[0]];
        }

        return [trace, compVals];
    }

    expect(b: boolean, msg?: string): asserts b {
        if (!b) {
            throw new InterpError(msg ? msg : ``);
        }
    }

    /**
     * Return an InferType instance relevant to the current state. Since infer-type is version dependent
     * we need to get the version of the current contract first
     */
    infer(s: State): sol.InferType {
        return this.artifactManager.infer(s.version);
    }

    typeof(e: sol.Expression, s: State): sol.TypeNode {
        return this.infer(s).typeOf(e);
    }

    isUnchecked(n: sol.ASTNode, s: State): boolean {
        // In Solidity older than 0.8.0 all operations are unchecked
        if (lt(s.version, "0.8.0")) {
            return true;
        }

        // In Solidity after 0.8.0 only operations inside an unchecked block are unchecked.
        return n.getClosestParentByType(sol.UncheckedBlock) !== undefined;
    }

    public lvToValue(lv: LValue, state: State): Value {
        if (lv instanceof BaseStorageView) {
            return lv.decode(state.storage);
        } else if (lv instanceof BaseMemoryView) {
            return lv.decode(state.memory);
        } else if (lv instanceof BaseCalldataView) {
            return lv.decode(getMsg(state));
        } else if (lv instanceof Array) {
            return lv.map((x) => this.lvToValue(x, state));
        } else if (lv instanceof PrimitiveLocalView) {
            return lv.decode();
        } else if (lv === null) {
            return none;
        }

        nyi(`LValue: ${lv}`);
    }

    evalUnaryOperation(expr: sol.UnaryOperation, state: State): [Trace, Value] {
        if (expr.vUserFunction) {
            nyi(`Unary user functions`);
        }

        if (expr.operator === "!") {
            const [trace, subVal] = this.eval(expr.vSubExpression, state);
            this.expect(typeof subVal === "boolean", `Unexpected value ${subVal} for unary !`);
            return [trace, !subVal];
        }

        // In all other cases the result is bigint
        let res: bigint;
        const unchecked = this.isUnchecked(expr, state);
        const t = this.infer(state).typeOf(expr);

        // Prefix/infix inc/dec require special handling as we need to
        // eval the subexpression as an LV. We can't evaluate it multiple times, as that may
        // duplicate state changes.
        if (expr.operator === "++" || expr.operator == "--") {
            const [trace, subExprLoc] = this.evalLV(expr.vSubExpression, state);
            const subVal = this.lvToValue(subExprLoc, state);
            this.expect(typeof subVal === "bigint", `Unexpected value ${subVal} for unary ~`);
            this.expect(state.scope !== undefined, `Need scope for ${expr.operator}`);

            const newVal = expr.operator === "++" ? subVal + 1n : subVal - 1n;
            this.assign(subExprLoc, newVal, state);
            res = expr.prefix ? newVal : subVal;

            return [trace, res];
        }

        const [trace, subVal] = this.eval(expr.vSubExpression, state);

        if (expr.operator === "-") {
            this.expect(typeof subVal === "bigint", `Unexpected value ${subVal} for unary -`);
            res = -subVal;
        } else if (expr.operator === "~") {
            this.expect(typeof subVal === "bigint", `Unexpected value ${subVal} for unary ~`);
            res = ~subVal;
        } else {
            // @todo implement ++, --, delete
            nyi(`Unary operator ${expr.operator}`);
        }

        return [trace, this.clamp(expr, res, t, unchecked)];
    }
}
