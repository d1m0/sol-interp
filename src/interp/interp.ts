import { ArtifactManager, nyi, zip } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { WorldInterface, State, SolMessage } from "./state";
import { EvalStep, ExecStep, Trace } from "./step";
import { InterpError, NoScope } from "./exceptions";
import { gte, lt } from "semver";
import { LValue, NoneValue, Value } from "./value";
import { Address } from "@ethereumjs/util";
import { BaseScope, LocalsScope } from "./scope";
import { makeZeroValue } from "./utils";
import { BaseStorageView } from "sol-dbg/dist/debug/decoding/storage/view";
import { BaseMemoryView } from "sol-dbg/dist/debug/decoding/memory/view";

enum ControlFlow {
    Fallthrough = 0,
    Break = 1,
    Continue = 2,
    Return = 3
}

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
            makeZeroValue(infer.variableDeclarationToTypeNode(ret))
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
        let trace: Trace = [];
        let varInitialVals: Value[] = [];
        let infer = this.infer(state);

        if (stmt.vInitialValue) {
            const [initVT, initVal] = this.eval(stmt.vInitialValue, state);
            
            trace.push(...initVT);
            varInitialVals = stmt.vInitialValue instanceof sol.TupleExpression && stmt.vInitialValue.vOriginalComponents.length > 1 ? initVal as Value[] : [initVal];
        } else{
            varInitialVals = stmt.vDeclarations.map((d) => makeZeroValue(infer.variableDeclarationToTypeNode(d)));
        }

        if (gte(state.version, "0.5.0")) {
            varInitialVals = varInitialVals.map((c, i) => c instanceof NoneValue ? makeZeroValue(infer.variableDeclarationToTypeNode(stmt.vDeclarations[i])) : c)
            this.pushScope(stmt, zip(stmt.vDeclarations.map((d) => d.name), varInitialVals), state);
        } else {
            for (let i = 0; i < stmt.vDeclarations.length; i++) {
                const decl = stmt.vDeclarations[i];
                const val = varInitialVals[i];

                sol.assert(state.scope !== undefined, `Missing scope`);

                if (!(val instanceof NoneValue)) {
                    state.scope.set(decl.name, val)
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
        sol.assert(state.scope !== undefined, ``)
        let trace: Trace = [];
        let retVals: Value[] = [];
        
        if (stmt.vExpression) {
            let retVal: Value;

            [trace, retVal] = this.eval(stmt.vExpression, state);
            retVals = stmt.vExpression instanceof sol.TupleExpression ? retVal as Value[] : [retVal];
        } else {
            retVals = [];
        }

        const fun = stmt.getClosestParentByType(sol.FunctionDefinition);

        sol.assert(
            fun !== undefined &&
            (retVals.length === fun.vReturnParameters.vParameters.length || retVals.length === 0),
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

        trace.push(new EvalStep(expr, res));
        //console.error(`eval(${sol.pp(expr, state)}) -> ${res}`);

        return [trace, res];
    }

    evalLV(expr: sol.Expression, state: State): [Trace, LValue] {
        if (expr instanceof sol.Identifier) {
            sol.assert(state.scope !== undefined, `Missing scope in evalLV({0})`, expr);
            const lv = state.scope.lookupLocation(expr.name);
            return [[new EvalStep(expr, lv)], lv];
        }

        nyi(`evalLV(${expr.print()})`);
    }

    evalAssignment(expr: sol.Assignment, state: State): [Trace, Value] {
        // @todo What is the order here?
        const [ltrace, lvalue] = this.evalLV(expr.vLeftHandSide, state);
        const [rtrace, rvalue] = this.eval(expr.vRightHandSide, state);

        // @todo handle coercions
        // @todo handle memory to storage copy
        // @todo handle storage to storage copy assignments

        if (lvalue instanceof BaseStorageView) {
            state.storage = lvalue.encode(rvalue, state.storage)
        } else if (lvalue instanceof BaseMemoryView) {
            lvalue.encode(rvalue, state.memory, state.allocator)
        } else if (lvalue instanceof Array) {
            const [localScope, name] = lvalue;
            localScope.set(name, rvalue);
        }

        // @todo do we return lvalue or rvalue here?
        return [[...ltrace, ...rtrace], rvalue];
    }

    private computeBinary(
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

            const clampedRes = type instanceof sol.IntType ? sol.clampIntToType(res, type) : res;
            const overflow = clampedRes !== res;

            if (overflow && !unchecked) {
                nyi(`Exception on overflow`);
            }

            return res;
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

    evalFunctionCall(expr: sol.FunctionCall, state: State): [Trace, Value] {
        nyi("");
    }

    evalIdentifier(expr: sol.Identifier, state: State): [Trace, Value] {
        if (!state.scope) {
            throw new NoScope();
        }

        return [[], state.scope.lookup(expr.name)];
    }

    evalIndexAccess(expr: sol.IndexAccess, state: State): [Trace, Value] {
        nyi("");
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

        // @todo finish literals
        nyi(`Literal ${expr.print()}`);
    }

    evalMemberAccess(expr: sol.MemberAccess, state: State): [Trace, Value] {
        nyi("");
    }

    evalTupleExpression(expr: sol.TupleExpression, state: State): [Trace, Value] {
        const trace: Trace = [];
        const compVals: Value[] = [];
        for (const comp of expr.vComponents) {
            if (comp === null) {
                compVals.push(new NoneValue());
            } else {
                const [t, v] = this.eval(comp, state);
                trace.push(...t);
                compVals.push(v);
            }
        }

        if (compVals.length === 0) {
            return [trace, new NoneValue()];
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

    evalUnaryOperation(expr: sol.UnaryOperation, state: State): [Trace, Value] {
        const [trace, subVal] = this.eval(expr.vSubExpression, state);

        if (expr.vUserFunction) {
            nyi(`Unary user functions`);
        }

        if (expr.operator === "!") {
            this.expect(typeof subVal === "boolean", `Unexpected value ${subVal} for unary !`);
            return [trace, !subVal];
        }

        // In all other cases the result is bigint
        let res: bigint;

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

        const t = this.infer(state).typeOf(expr);
        this.expect(
            t instanceof sol.IntType || t instanceof sol.NumericLiteralType,
            `Unexpected unary expr type`
        );

        // If this is a constant expression we have infinite precision - just return the raw value
        if (t instanceof sol.NumericLiteralType) {
            return [trace, res];
        }

        // Otherwise we must clamp down the type. Note this may overflow. In which case we need to raise an exception
        const clampedRes = sol.clampIntToType(res, t);

        // No over/under flow
        if (res === clampedRes) {
            return [trace, res];
        }

        // Unchecked over/under flow
        if (this.isUnchecked(expr, state)) {
            return [trace, res];
        }

        // Throw internal exception
        nyi(`Exception on overflow`);
    }
}
