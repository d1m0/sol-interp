import { ArtifactManager, ImmMap, nyi, Storage } from "sol-dbg";
import { Interpreter } from "../../src";
import { CallResult, State, WorldInterface } from "../../src/interp/state";
import * as sol from "solc-typed-ast";
import { Value } from "sol-dbg/dist/debug/decoding/value";
import * as fse from "fs-extra";
import { BaseScope, ContractScope, LocalsScope } from "../../src/interp/scope";

const worldMock: WorldInterface = {
    create: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    call: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    staticcall: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    delegatecall: function (): Promise<CallResult> {
        throw new Error("Function not implemented.");
    },
    getStorage: function (): Storage {
        throw new Error("Function not implemented.");
    }
};

function makeState(loc: sol.ASTNode, infer: sol.InferType, ...vals: Array<[string, Value]>): State {
    const res: State = {
        storage: ImmMap.fromEntries([]),
        memory: new Uint8Array([]),
        extCallStack: [],
        intCallStack: [],
        version: "0.8.29",
        scope: undefined,
        localsStack: []
    };

    let nd: sol.ASTNode | undefined = loc;
    const scopeNodes: sol.ASTNode[] = [];

    while (nd !== undefined) {
        if (
            nd instanceof sol.ContractDefinition ||
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            scopeNodes.unshift(nd);
        }
        nd = nd.parent;
    }

    let scope: BaseScope | undefined;
    for (const nd of scopeNodes) {
        if (nd instanceof sol.ContractDefinition) {
            scope = new ContractScope(nd, infer, res, scope);
        } else if (
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            res.localsStack.push(new Map());
            scope = new LocalsScope(nd, res, scope);
        } else {
            nyi(`Scope nd ${nd.print()}`);
        }
    }

    res.scope = scope as BaseScope;

    for (const [name, val] of vals) {
        res.scope.set(name, val);
    }

    return res;
}

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
