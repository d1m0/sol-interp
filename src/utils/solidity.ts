import * as sol from "solc-typed-ast";

// For Solidity 0.4.x there is a single scope for the whole function/modifier
export function isBlock04Scope(block: sol.Block | sol.UncheckedBlock): boolean {
    return (
        block.parent instanceof sol.FunctionDefinition ||
        block.parent instanceof sol.ModifierDefinition
    );
}
