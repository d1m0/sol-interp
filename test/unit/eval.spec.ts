import { Struct, Value, View } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import { loadSamples, makeState, SampleInfo, SampleMap } from "./utils";
import { decodeView, worldFailMock } from "../../src/interp/utils";
import { ArtifactManager } from "../../src/interp/artifactManager";

const samples: Array<[string, string, Array<[string, Value]>, Value]> = [
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='a']/*[2]", [], 1n],
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='b']/*[2]", [], -1n],
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='c']/*[2]", [], 3n],
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='d']/*[2]", [], true],
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='e']/*[2]", [], true],
    ["expressions.sol", "//ContractDefinition/VariableDeclaration[@name='f']/*[2]", [], -2n],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/Block[1]/VariableDeclarationStatement/BinaryOperation",
        [["a", 5n]],
        6n
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/Block[1]/ExpressionStatement/Assignment/Conditional",
        [
            ["d", true],
            ["e", true],
            ["a", 1n]
        ],
        8n
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[1]/*[1]",
        [["arr", [1n, 2n, 3n, 4n]]],
        4n
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[2]/*[1]",
        [
            [
                "s",
                new Struct([
                    ["x", 2n],
                    ["b", false]
                ])
            ]
        ],
        2n
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[3]/*[1]",
        [
            [
                "s",
                new Struct([
                    ["x", 2n],
                    ["b", true]
                ])
            ]
        ],
        true
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[4]/*[1]",
        [
            [
                "s1",
                new Struct([
                    [
                        "s",
                        [
                            new Struct([
                                ["x", 3n],
                                ["b", true]
                            ])
                        ]
                    ]
                ])
            ]
        ],
        3n
    ],
    [
        "type_conversions_08.sol",
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/ExpressionStatement[1]/*[1]",
        [],
        1n
    ],
    [
        "type_conversions_07.sol",
        "//ContractDefinition/FunctionDefinition[@name='main']/Block[1]/ExpressionStatement[2]/*[1]",
        [],
        0n
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[5]/*[1]",
        [],
        [1n, 2n, 3n]
    ],
    [
        "expressions.sol",
        "//ContractDefinition/FunctionDefinition[@name='foo']/Block[1]/ExpressionStatement[6]/*[1]",
        [],
        [
            [1n, 2n],
            [3n, 4n]
        ]
    ]
];

describe("Eval unit tests", () => {
    let artifactManager: ArtifactManager;
    let sampleMap: SampleMap;

    const fileNames = [...new Set<string>(samples.map(([name]) => name))];

    beforeAll(async () => {
        [artifactManager, sampleMap] = await loadSamples(fileNames);
    }, 10000);

    for (const [fileName, path, defs, expValue] of samples) {
        it(path, () => {
            const sample = sampleMap.get(fileName) as SampleInfo;
            const contract = sample.units[0].vContracts[0];
            const interp = new Interpreter(
                worldFailMock,
                artifactManager,
                artifactManager.getArtifact(contract)
            );
            const expr = new sol.XPath(contract).query(path)[0] as sol.Expression;
            const state = makeState(expr, interp, ...defs);
            expect(expr).toBeDefined();
            let v: any = interp.eval(expr, state);

            if (v instanceof View) {
                v = decodeView(v, state);
            }

            expect(v).toEqual(expValue);
        });
    }
});
