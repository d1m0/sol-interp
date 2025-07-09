import { BuiltinFunctionType, types } from "solc-typed-ast";
import * as sol from "solc-typed-ast";
import { BuiltinFunction, Value } from "./value";
import { State } from "./state";
import { Assert } from "./exceptions";

export const assertBuiltin = new BuiltinFunction(
    "assert",
    new BuiltinFunctionType("assert", [types.bool, types.stringMemory], []),
    (state: State, args: Value[]): Value[] => {
        if (
            args.length < 1 ||
            args.length > 2 ||
            typeof args[0] !== "boolean" ||
            (args.length == 2 && typeof args[1] !== "string")
        ) {
            sol.assert(false, `Unexpected args for assert: ${args}`);
        }

        if (!args[0]) {
            throw new Assert(args.length === 2 ? (args[1] as string) : "");
        }

        return [];
    }
);
