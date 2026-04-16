import {
    ASTNode,
    ContractDefinition,
    FunctionDefinition,
    FunctionStateMutability,
    FunctionVisibility,
    getterArgsAndReturn,
    ModifierDefinition,
    SourceUnit,
    StateVariableVisibility,
    typeOf,
    VariableDeclaration
} from "solc-typed-ast";
import { assert } from "../utils";
import { typeIdToRuntimeType } from "./types";

export type OverridableSolDef = FunctionDefinition | ModifierDefinition;

// Function mutability change order, lower to higher
const mutabilityOrder: FunctionStateMutability[] = [
    FunctionStateMutability.Pure,
    FunctionStateMutability.Constant,
    FunctionStateMutability.View,
    FunctionStateMutability.NonPayable
];

function matchDefs<T extends OverridableSolDef>(
    overriden: T,
    overriding: T | VariableDeclaration
): boolean {
    if (overriden.name !== overriding.name) {
        return false;
    }

    // Overriding is only allowed to change visibility from external to public
    if (
        overriden.visibility !== overriding.visibility &&
        !(
            overriden.visibility === FunctionVisibility.External &&
            overriding.visibility === FunctionVisibility.Public
        )
    ) {
        return false;
    }

    if (overriden instanceof FunctionDefinition && overriding instanceof FunctionDefinition) {
        if (overriden.stateMutability !== overriding.stateMutability) {
            // Overriding is not allowed to change payable function state mutability
            if (overriden.stateMutability === FunctionStateMutability.Payable) {
                return false;
            }

            if (
                mutabilityOrder.indexOf(overriden.stateMutability) <
                mutabilityOrder.indexOf(overriding.stateMutability)
            ) {
                return false;
            }
        }
    }

    const ctx = overriding.context;
    assert(ctx !== undefined, ``);
    const overridenParamTs = overriden.vParameters.vParameters
        .map((d) => typeOf(d))
        .map((t) => typeIdToRuntimeType(t, ctx));
    const overridingParamTs =
        overriding instanceof VariableDeclaration
            ? getterArgsAndReturn(overriding)[0]
            : overriding.vParameters.vParameters
                  .map((d) => typeOf(d))
                  .map((t) => typeIdToRuntimeType(t, ctx));

    if (overridenParamTs.length !== overridingParamTs.length) {
        return false;
    }

    for (let i = 0; i < overridenParamTs.length; i++) {
        if (overridingParamTs[i].pp() != overridenParamTs[i].pp()) {
            return false;
        }
    }

    return true;
}
export function resolve(
    def: OverridableSolDef,
    inCtx: ASTNode
): OverridableSolDef | VariableDeclaration | undefined {
    const scope = def.vScope;
    // Global function
    if (scope instanceof SourceUnit) {
        return def;
    }

    assert(scope instanceof ContractDefinition, `Unexpected scope {0}`, scope);

    const mdc =
        inCtx instanceof ContractDefinition
            ? inCtx
            : inCtx.getClosestParentByType(ContractDefinition);
    assert(mdc !== undefined, `Resolving a methdo from outside of a contract scope`);

    for (const base of mdc.vLinearizedBaseContracts) {
        if (base === scope) {
            return def;
        }

        if (def instanceof FunctionDefinition) {
            for (const method of base.vFunctions) {
                if (matchDefs(def, method)) {
                    return method;
                }
            }

            for (const stateVar of base.vStateVariables) {
                if (stateVar.visibility !== StateVariableVisibility.Public) {
                    continue;
                }

                if (matchDefs(def, stateVar)) {
                    return stateVar;
                }
            }
        } else {
            for (const mod of base.vModifiers) {
                if (matchDefs(def, mod)) {
                    return mod;
                }
            }
        }
    }

    return undefined;
}
