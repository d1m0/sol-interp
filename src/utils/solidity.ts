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

/**
 * Given a public state variable declaration `v` return the ABI types of the arguments and the returns for this var.
 * This will account for:
 *  - indexing into arrays/maps
 *  - omitting arrays and maps
 *
 * @todo This duplicates solc-typed-ast's getterArgsAndReturn, but differs from it in that it doesn't convert individual returned
 * tuple types into their ABI versions. So individiual tuple component struct types are preserved. Perhaps resolve this duplication somehow?
 * @param t
 * @param loc
 * @returns
 */
export function getterArgsAndReturn(
    v: sol.VariableDeclaration
): [sol.TypeIdentifier[], sol.TypeIdentifier] {
    const argTypes: sol.TypeIdentifier[] = [];
    const ctx = v.requiredContext;

    let type = v.vType;

    sol.assert(
        type !== undefined,
        "Called getterArgsAndReturn() on variable declaration without type",
        v
    );

    while (true) {
        if (type instanceof sol.ArrayTypeName) {
            argTypes.push(new sol.IntTypeId(256, false));

            type = type.vBaseType;
        } else if (type instanceof sol.Mapping) {
            // Make sure to change default storage pointer location for string/bytes to Memory as to not
            // confuse `toABIType`.
            argTypes.push(sol.changeLocationTo(sol.typeOf(type.vKeyType), sol.DataLocation.Memory));

            type = type.vValueType;
        } else {
            break;
        }
    }

    const solT = sol.changeLocationTo(sol.typeOf(type), sol.DataLocation.Memory);
    let retTs: sol.TypeIdentifier[];

    if (solT instanceof sol.PointerTypeId && solT.toType instanceof sol.StructTypeId) {
        const def = ctx.locate(solT.toType.id) as sol.StructDefinition;
        // Filter out top-level arrays and maps
        retTs = def.vMembers
            .map((decl) => sol.changeLocationTo(sol.typeOf(decl), sol.DataLocation.Memory))
            .filter(
                (t) =>
                    !(
                        (t instanceof sol.PointerTypeId && t.toType instanceof sol.ArrayTypeId) ||
                        t instanceof sol.MappingTypeId
                    )
            );
    } else {
        retTs = [solT];
    }

    const retType = retTs.length === 1 ? retTs[0] : new sol.TupleTypeId(retTs);

    return [argTypes, retType];
}
