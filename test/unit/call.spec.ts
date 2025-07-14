import { ArtifactManager, PartialSolcOutput, View } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { makeState, worldMock } from "./utils";
import { Assert } from "../../src/interp/exceptions";
import { hexToBytes } from "@ethereumjs/util";
import { Value } from "../../src/interp/value";

type ExceptionConstructors = typeof Assert;
const samples: Array<
    [string, string, string, Array<[string, Value]>, Value[], Value[] | ExceptionConstructors]
> = [
    ["initial.sol", "Foo", "sqr", [], [2n], [4n]],
    ["initial.sol", "Foo", "localVarScope", [], [], [5n]],
    ["initial.sol", "Foo", "assrt", [], [true], []],
    ["initial.sol", "Foo", "assrt", [], [false], Assert],
    ["assignments.sol", "Assignments", "simpleAssignment", [], [], []],
    ["assignments.sol", "Assignments", "multipleAssignmentsLong", [], [], []],
    ["assignments.sol", "Assignments", "multipleAssignmentsShort", [], [], []],
    ["assignments.sol", "Assignments", "tupleDeclaration", [], [], []],
    ["assignments.sol", "Assignments", "tupleNested", [], [], []],
    ["assignments.sol", "Assignments", "tupleEvaluateAllInitialExpressions", [], [], [1337n]],
    ["OoO.sol", "OoO", "assignmentOOO", [], [], [hexToBytes("0x00000100000000000000"), 3n]],
    ["OoO.sol", "OoO", "indexAccess", [], [], []],
    ["OoO.sol", "OoO", "tuples", [], [], [1n, 2n]],
    ["OoO.sol", "OoO", "tupleAssignments", [], [], []],
    ["OoO.sol", "OoO", "binOps", [], [], []],
];

describe("Simple function call tests", () => {
    let artifactManager;
    let interp: Interpreter;
    const infer = new sol.InferType("0.8.29");
    const fileNames = [...new Set<string>(samples.map(([name]) => name))];
    const unitMap = new Map<string, sol.SourceUnit>();

    beforeAll(async () => {
        const compileResults: PartialSolcOutput[] = [];
        for (const fileName of fileNames) {
            const file = fse.readFileSync(`test/samples/${fileName}`, {
                encoding: "utf-8"
            });
            const compileResult = await sol.compileSourceString(
                fileName,
                file,
                "0.8.29",
                undefined,
                undefined,
                { viaIR: true }
            );
            compileResults.push(compileResult.data);
        }

        artifactManager = new ArtifactManager(compileResults);
        interp = new Interpreter(worldMock, artifactManager);
        for (let i = 0; i < fileNames.length; i++) {
            unitMap.set(fileNames[i], artifactManager.artifacts()[i].units[0]);
        }
    }, 10000);

    for (const [fileName, contract, funName, stateVals, args, expectedReturns] of samples) {
        it(`${fileName}:${contract}.${funName}(${args.map((arg) => String(arg)).join(", ")})`, () => {
            const unit = unitMap.get(fileName) as sol.SourceUnit;
            const fun = new sol.XPath(unit).query(
                `//ContractDefinition[@name='${contract}']/FunctionDefinition[@name='${funName}']`
            )[0] as sol.FunctionDefinition;
            const state = makeState(fun, infer, ...stateVals);

            if (expectedReturns instanceof Array) {
                try {
                    let [, returns] = interp.callInternal(fun, args, state);
                    returns = returns.map((ret) =>
                        ret instanceof View ? interp.lvToValue(ret, state) : ret
                    );
                    expect(returns).toEqual(expectedReturns);
                } catch (e) {
                    console.error(`Unexpected exception ${e}`);
                    expect(false).toBeTruthy();
                }
            } else {
                expect(() => {
                    interp.callInternal(fun, args, state);
                }).toThrow(expectedReturns);
            }
        });
    }
});
