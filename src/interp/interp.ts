import { ArtifactManager, nyi } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { WorldInterface, State, SolMessage } from "./state";
import { EvalStep, Trace } from "./step";
import { InterpError, NoScope } from "./exceptions";
import { lt } from "semver";
import { NoneValue, Value } from "./value";
import { Address } from "@ethereumjs/util";
import { LocalsScope } from "./scope";

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
    ) { }

    ///*********************EXTERNAL FUNCTION CALLS************************************
    public create(msg: SolMessage, state: State): [Trace, Address] {
        nyi(`create`);
    }

    public call(msg: SolMessage, state: State): [Trace, Value[] | InterpError] {
        nyi(`create`);
    }

    ///*********************MODIFIERS/INTERNAL FUNCTION CALLS**************************
    public callInternal(
        callee: sol.FunctionDefinition,
        args: Value[],
        state: State
    ): [Trace, Value[]] {
        sol.assert(args.length === callee.vParameters.vParameters.length, `Mismatch in number of args when calling {0}`, callee.name)
        const scopeStore = new Map<string, Value>();
        state.localsStack.push(scopeStore);
        state.scope = new LocalsScope(callee, state, state.scope)
    }
    ///*********************STATEMENTS*************************************************
    public exec(stmt: sol.Statement, state: State): ControlFlow {
        nyi(`exec`);
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

    evalAssignment(expr: sol.Assignment, state: State): [Trace, Value] {
        nyi("");
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
