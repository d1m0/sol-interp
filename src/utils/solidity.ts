import * as sol from "solc-typed-ast";

// For Solidity 0.4.x there is a single scope for the whole function/modifier
export function isBlock04Scope(block: sol.Block | sol.UncheckedBlock): boolean {
    return (
        block.parent instanceof sol.FunctionDefinition ||
        block.parent instanceof sol.ModifierDefinition
    );
}

export function getActuallCalleeExpr(callee: sol.Expression): sol.Expression {
    if (callee instanceof sol.FunctionCallOptions) {
        return getActuallCalleeExpr(callee.vExpression);
    }

    if (callee instanceof sol.FunctionCall) {
        sol.assert(
            callee.vFunctionName === "gas" ||
                callee.vFunctionName === "value" ||
                callee.vFunctionName === "salt",
            ``
        );
        sol.assert(callee.vExpression instanceof sol.MemberAccess, ``);
        return getActuallCalleeExpr(callee.vExpression.vExpression);
    }

    if (callee instanceof sol.TupleExpression && callee.vOriginalComponents.length === 1) {
        const comp = callee.vOriginalComponents[0];
        sol.assert(comp !== null, ``);
        return getActuallCalleeExpr(comp);
    }

    return callee;
}
