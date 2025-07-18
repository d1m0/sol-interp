import { BuiltinFunctionType, types } from "solc-typed-ast";
import * as sol from "solc-typed-ast";
import { BuiltinFunction, Value } from "./value";
import { State } from "./state";
import { Assert } from "./exceptions";
import { Interpreter } from "./interp";

export const assertBuiltin = new BuiltinFunction(
    "assert",
    new BuiltinFunctionType("assert", [types.bool], []),
    (interp: Interpreter, state: State, args: Value[]): Value[] => {
        if (args.length != 1 || typeof args[0] !== "boolean") {
            sol.assert(false, `Unexpected args for assert: ${args}`);
        }

        if (!args[0]) {
            throw new Assert(interp.curNode, interp.trace, ``);
        }

        return [];
    }
);
