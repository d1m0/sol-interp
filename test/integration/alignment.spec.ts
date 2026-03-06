import { loadSamples, txDescToBlockData, txDescToTxData } from "../unit/utils";
import * as fse from "fs-extra";
import { Scenario } from "sol-dbg";
import { buildAlignedTraces } from "../../src";
import { createAddressFromString } from "@ethereumjs/util";
import { scenarioInitialStateToAccountMap } from "../unit/utils";
import { AlignedTraces, hasUnmached } from "../../src/alignment/trace_builder";

const misalignmentSamples: Array<[string, any]> = [
    [
        "out_of_gas.config.json",
        [
            [1, 1, false, ["EVMCreateEvent", "SolCreateEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMCallEvent", "SolCallEvent"]],
            [2, 2, false, ["EVMCreateEvent", "SolCreateEvent"]],
            [3, 3, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [2, 2, false, ["EVMCallEvent", "SolCallEvent"]],
            [3, 3, true, ["EVMExceptionEvent", "SolExceptionEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMReturnEvent", "SolReturnEvent"]]
        ]
    ],
    [
        "events.config.json",
        [
            [1, 1, false, ["EVMCreateEvent", "SolCreateEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMCallEvent", "SolCallEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMCallEvent", "SolCallEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMExceptionEvent", "SolExceptionEvent"]],
            [1, 1, false, ["EVMCallEvent", "SolCallEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, false, ["EVMEmitEvent", "SolEmitEvent"]],
            [2, 2, true, ["EVMExceptionEvent", "SolExceptionEvent"]],
            [1, 1, false, ["EVMReturnEvent", "SolReturnEvent"]]
        ]
    ]
];

const hasMisalignment: Set<string> = new Set(misalignmentSamples.map((t) => t[0]));

const sol2maruirScenarios: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.json"));

describe("Trace Alignment Tests", () => {
    for (const sample of sol2maruirScenarios) {
        if (hasMisalignment.has(sample)) {
            return;
        }

        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, stateAfter] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc),
                    artifactManager
                );
                state = stateAfter;
                expect(hasUnmached(alignedTraces)).toEqual(false);
            }
        });
    }
});

function alignedTraceToDesc(t: AlignedTraces): any {
    const res: any[] = [];

    for (const [llT, hlT, [llEv, hlEv]] of t) {
        res.push([
            llT[0].depth,
            llT[llT.length - 1].depth,
            hlT === undefined,
            [llEv.constructor.name, hlEv.constructor.name]
        ]);
    }

    return res;
}

describe("Trace Misalignment Tests", () => {
    for (const [sample, desc] of misalignmentSamples) {
        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, stateAfter] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc),
                    artifactManager,
                    10000
                );
                state = stateAfter;
                if (i === 1) {
                    expect(hasUnmached(alignedTraces)).toEqual(true);
                    expect(alignedTraceToDesc(alignedTraces)).toEqual(desc);
                }
            }
        });
    }
});
