import { View, Value, zip } from "sol-dbg";
import { Interpreter } from "../../src";
import * as sol from "solc-typed-ast";
import { encodeMemArgs, loadSamples, makeState, SampleInfo, SampleMap } from "./utils";
import { Assert, InterpError, RuntimeError } from "../../src/interp/exceptions";
import { hexToBytes } from "@ethereumjs/util";
import { worldFailMock } from "../../src/interp/utils";
import { ArtifactManager } from "../../src/interp/artifactManager";

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
    [
        "MemoryAliasing.sol",
        "MemoryAliasing",
        "arraysInMemoryStructs",
        [],
        [],
        [
            [42n, 80n, 3n, 4n],
            [42n, 80n, 3n, 4n]
        ]
    ],
    ["MemoryAliasing.sol", "MemoryAliasing", "structInMemoryStructs", [], [], []],
    ["MemoryAliasing.sol", "MemoryAliasing", "structsInMemoryArrays", [], [], []],
    ["MemoryAliasing.sol", "MemoryAliasing", "structReAssignment", [], [], []],
    ["MemoryAliasing.sol", "MemoryAliasing", "structReAssignmentFromStorage", [], [], []],
    ["MemoryAliasing.sol", "MemoryAliasing", "localMemArrayLitInit", [], [], []],
    ["StorageAliasing.sol", "StorageAliasing", "arrays", [], [], []],
    ["StorageAliasing.sol", "StorageAliasing", "arraysInStructs", [], [], []],
    ["StorageAliasing.sol", "StorageAliasing", "maps", [], [], []],
    ["StorageAliasing.sol", "StorageAliasing", "structInStructCopy", [], [], []],
    ["InMemoryStructWithMapping.sol", "Test", "verify", [], [], []],
    ["InMemoryStructWithMapping.sol", "Test", "verifyMapArr", [], [], []],
    ["calls.sol", "Calls", "main", [], [], []],
    ["new.sol", "New", "main", [], [], []],
    ["global_constants.sol", "Foo", "main", [], [], []],
    ["contract_constants.sol", "Foo", "main", [["s", 1n]], [], []],
    ["def_value.sol", "Bar", "main", [], [], []],
    ["selectors.sol", "Foo", "main", [], [], []],
    ["cross_file_constant_deps1.sol", "Main", "main", [], [], []],
    ["type_conversions_more.sol", "Foo", "main", [], [], []],
    ["type_conversions_more.sol", "Foo", "binops", [], [], []],
    ["modifiers.sol", "Foo", "main", [], [], []],
    ["global_fun_main.sol", "Foo", "main", [], [], []],
    ["virtual_modifiers.sol", "Child", "main", [], [], []],
    ["virtual_abstract_method.sol", "Child", "main", [], [], []],
    ["push.sol", "Foo", "main", [], [], []],
    ["call_implicit_casts.sol", "Foo", "main", [], [], []],
    ["units.sol", "Foo", "main", [], [], []],
    ["return_uninitialized_mem_struct.sol", "Foo", "main", [], [], []],
    ["RationalTest.sol", "RationalTest", "subdenominationEtherTest", [], [], []],
    ["RationalTest.sol", "RationalTest", "subdenominationTimeTest", [], [], []],
    ["RationalTest.sol", "RationalTest", "mathTest", [], [], []],
    ["RationalTest.sol", "RationalTest", "extremeDenominatedValues", [], [], []]
];

describe("Simple function call tests", () => {
    let artifactManager: ArtifactManager;
    let sampleMap: SampleMap;

    const fileNames = [...new Set<string>(samples.map(([name]) => name))];

    beforeAll(async () => {
        [artifactManager, sampleMap] = await loadSamples(fileNames);
    }, 10000);

    for (const [fileName, contract, funName, stateVals, argVals, expectedReturns] of samples) {
        it(`${fileName}:${contract}.${funName}(${argVals.map((arg) => String(arg)).join(", ")})`, () => {
            const info = sampleMap.get(fileName) as SampleInfo;

            let fun: sol.FunctionDefinition | undefined = undefined;
            const interp: Interpreter = new Interpreter(
                worldFailMock,
                artifactManager,
                artifactManager.getArtifact(info.units[0])
            );

            for (const unit of info.units) {
                fun = new sol.XPath(unit).query(
                    `//ContractDefinition[@name='${contract}']/FunctionDefinition[@name='${funName}']`
                )[0];

                if (fun !== undefined) {
                    break;
                }
            }

            sol.assert(fun !== undefined, `Couldn't find ${contract}.${funName} in ${fileName}`);
            const state = makeState(fun, interp, ...stateVals);

            const args = zip(
                fun.vParameters.vParameters.map((d) => d.name),
                argVals
            );
            const argTs = fun.vParameters.vParameters.map((decl) =>
                interp._infer.variableDeclarationToTypeNode(decl)
            );
            if (expectedReturns instanceof Array) {
                try {
                    const returns = interp.callInternal(
                        fun,
                        encodeMemArgs(args, state),
                        argTs,
                        state
                    );
                    const decodedReturns = returns.map((ret) =>
                        ret instanceof View ? interp.decode(ret, state) : ret
                    );
                    expect(decodedReturns).toEqual(expectedReturns);
                } catch (e) {
                    if (e instanceof InterpError) {
                        //console.error(`Trace: ${ppTrace(e.trace)}`);
                        //console.error(`Memory: ${ppMem(state.memory)}`)
                        console.error(
                            `Unexpected ${e instanceof RuntimeError ? "runtime" : "internal"} error: ${e.stack}`
                        );
                    } else {
                        // console.error(`Trace: ${ppTrace(interp.trace)}`);
                        console.error(`Unexpected unrelated exception ${(e as Error).stack}`);
                    }
                    expect(false).toBeTruthy();
                }
            } else {
                expect(() => {
                    interp.callInternal(fun, encodeMemArgs(args, state), argTs, state);
                }).toThrow(expectedReturns);
            }
        });
    }
});
