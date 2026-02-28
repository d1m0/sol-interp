import { loadSamples, txDescToBlockData, txDescToTxData } from "../unit/utils";
import * as fse from "fs-extra";
import { Scenario } from "sol-dbg";
import { buildAlignedTraces } from "../../src";
import { createAddressFromString } from "@ethereumjs/util";
import { scenarioInitialStateToAccountMap } from "../unit/utils";
import { getCommon } from "../../src/alignment/evm_trace";
import { hasUnmached } from "../../src/alignment/trace_builder";

const sol2maruirScenarios: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.json"));

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Trace Alignment Tests", () => {
    for (const sample of sol2maruirScenarios) {
        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            const common = getCommon();
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, stateAfter] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc, common),
                    artifactManager
                );
                state = stateAfter;
                expect(!hasUnmached(alignedTraces)).toBeTruthy();
            }
        });
    }
});
