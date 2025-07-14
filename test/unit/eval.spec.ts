import { ArtifactManager } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { makeState, worldMock } from "./utils";
import { Value } from "../../src/interp/value";

const samples: Array<[string, Array<[string, Value]>, Value]> = [
    ["//ContractDefinition/VariableDeclaration[@name='a']/*[2]", [], 1n],
    ["//ContractDefinition/VariableDeclaration[@name='b']/*[2]", [], -1n],
    ["//ContractDefinition/VariableDeclaration[@name='c']/*[2]", [], 3n],
    ["//ContractDefinition/VariableDeclaration[@name='d']/*[2]", [], true],
    ["//ContractDefinition/VariableDeclaration[@name='e']/*[2]", [], true],
    ["//ContractDefinition/VariableDeclaration[@name='f']/*[2]", [], -2n],
    [
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/Block[1]/VariableDeclarationStatement/BinaryOperation",
        [["a", 5n]],
        6n
    ],
    [
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/Block[1]/ExpressionStatement/Assignment/Conditional",
        [
            ["d", true],
            ["e", true],
            ["a", 1n]
        ],
        8n
    ]
];

describe("Eval unit tests", () => {
    let artifactManager;
    let contract: sol.ContractDefinition;
    let interp: Interpreter;
    const infer = new sol.InferType("0.8.29");

    beforeAll(async () => {
        const file = fse.readFileSync("test/samples/expressions.sol", {
            encoding: "utf-8"
        });
        const compileResult = await sol.compileSourceString(
            "expressions.sol",
            file,
            "0.8.29",
            undefined,
            undefined,
            { viaIR: true }
        );
        artifactManager = new ArtifactManager([compileResult.data]);
        interp = new Interpreter(worldMock, artifactManager);
        contract = artifactManager.contracts()[0].ast as sol.ContractDefinition;
    });

    for (const [path, defs, expValue] of samples) {
        it(path, () => {
            const expr = new sol.XPath(contract).query(path)[0] as sol.Expression;
            const state = makeState(expr, infer, ...defs);
            expect(expr).toBeDefined();
            const [, v] = interp.eval(expr, state);
            expect(v).toEqual(expValue);
        });
    }
});
