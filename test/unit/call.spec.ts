import { ArtifactManager } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import { Value } from "sol-dbg/dist/debug/decoding/value";
import * as fse from "fs-extra";
import { makeState, worldMock } from "./utils";

const samples: Array<[string, string, Array<[string, Value]>, Value[], Value[]]> = [
    ["Foo", "sqr", [], [2n], [4n]],
    ["Foo", "localVarScope", [], [], [5n]]
];

describe("Simple function call tests", () => {
    let artifactManager;
    let unit: sol.SourceUnit;
    let interp: Interpreter;
    const infer = new sol.InferType("0.8.29");

    beforeAll(async () => {
        const file = fse.readFileSync("test/samples/single_function_call.sol", {
            encoding: "utf-8"
        });
        const compileResult = await sol.compileSourceString(
            "single_function_call.sol",
            file,
            "0.8.29",
            undefined,
            undefined,
            { viaIR: true }
        );
        artifactManager = new ArtifactManager([compileResult.data]);
        interp = new Interpreter(worldMock, artifactManager);
        unit = artifactManager.artifacts()[0].units[0];
    });

    for (const [contract, funName, stateVals, args, expectedReturns] of samples) {
        it(`${contract}.${funName}`, () => {
            const fun = new sol.XPath(unit).query(
                `//ContractDefinition[@name='${contract}']/FunctionDefinition[@name='${funName}']`
            )[0] as sol.FunctionDefinition;
            const state = makeState(fun, infer, ...stateVals);
            const [, returns] = interp.callInternal(fun, args, state);

            expect(returns).toEqual(expectedReturns);
        });
    }
});
