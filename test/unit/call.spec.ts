import { View, Value, zip } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import { encodeMemArgs, loadSamples, makeState, SampleInfo, SampleMap, worldMock } from "./utils";
import { Assert } from "../../src/interp/exceptions";
import { hexToBytes } from "@ethereumjs/util";
import { ppMem } from "../../src/interp/pp";

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
        ["ifs_v04.sol", "Ifs", "ifElseStatementNested", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifElseStatement", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifStatement", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifElseStatementWithExpressions", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifStatementWithExpression", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifStatementWithReturn", [], [], []],
        ["ifs_v04.sol", "Ifs", "ifStatementWithThrow", [], [], []],
        ["while_v04.sol", "While", "whileStatementWithBlock", [], [], []],
        ["while_v04.sol", "While", "whileStatementWithExpression", [], [], []],
        ["while_v04.sol", "While", "whileStatementWithLoopControlStatements", [], [], []],
        ["while_v04.sol", "While", "doWhileStatementWithBlock", [], [], []],
        ["while_v04.sol", "While", "doWhileStatementWithExpression", [], [], []],
        ["while_v04.sol", "While", "doWhileStatementWithLoopControlStatements", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementCompleteWithExpression", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementCompleteWithBlock", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementInitializationWithNoDeclaration", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementNoInitialization", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementNoLoopExpression", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementNoLoopCondition", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementLoopExpressionOnly", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementLoopConditionOnly", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementLoopInitializationOnly", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementEmpty", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementWithLoopControlStatements", [], [], []],
        ["fors_v04.sol", "ForLoops", "forStatementwithTernaryInHeader", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "primitiveValuesDontAlias", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "arrays", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "nestedArrays", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "structs", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "arraysInMemoryStructs", [], [], [[42n, 80n, 3n, 4n], [42n, 80n, 3n, 4n]]],
        ["MemoryAliasing.sol", "MemoryAliasing", "structInMemoryStructs", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "structsInMemoryArrays", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "structReAssignment", [], [], []],
        ["MemoryAliasing.sol", "MemoryAliasing", "structReAssignmentFromStorage", [], [], []],
    ];

describe("Simple function call tests", () => {
    let artifactManager;
    let interp: Interpreter;
    let sampleMap: SampleMap;

    const fileNames = [...new Set<string>(samples.map(([name]) => name))];

    beforeAll(async () => {
        [artifactManager, sampleMap] = await loadSamples(fileNames);
        interp = new Interpreter(worldMock, artifactManager);
    }, 10000);

    for (const [fileName, contract, funName, stateVals, argVals, expectedReturns] of samples) {
        it(`${fileName}:${contract}.${funName}(${argVals.map((arg) => String(arg)).join(", ")})`, () => {
            const { unit, version } = sampleMap.get(fileName) as SampleInfo;
            const fun = new sol.XPath(unit).query(
                `//ContractDefinition[@name='${contract}']/FunctionDefinition[@name='${funName}']`
            )[0] as sol.FunctionDefinition;
            const state = makeState(fun, version, ...stateVals);

            const args = zip(
                fun.vParameters.vParameters.map((d) => d.name),
                argVals
            );
            if (expectedReturns instanceof Array) {
                try {
                    let [, returns] = interp.callInternal(fun, encodeMemArgs(args, state), state);
                    const decodedReturns = returns.map((ret) =>
                        ret instanceof View ? interp.decode(ret, state) : ret
                    );
                    expect(decodedReturns).toEqual(expectedReturns);
                } catch (e) {
                    console.error(`Unexpected exception ${e} ${(e as Error).stack}`);
                    console.error(`Memory: ${ppMem(state.memory)}`)
                    expect(false).toBeTruthy();
                }
            } else {
                expect(() => {
                    interp.callInternal(fun, encodeMemArgs(args, state), state);
                }).toThrow(expectedReturns);
            }
        });
    }
});
