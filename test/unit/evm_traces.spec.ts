import { loadSamples, txDescToBlockData, txDescToTxData } from "../unit/utils";
import * as fse from "fs-extra";
import { Scenario } from "sol-dbg";
import {} from "@ethereumjs/tx";
import {} from "@ethereumjs/common";
import { createAddressFromString } from "@ethereumjs/util";
import { getCommon } from "../../src/alignment/trace_builder";
import {} from "@ethereumjs/block";
import { scenarioInitialStateToAccountMap } from "../unit/utils";
import { isReturn, replayEVM } from "../../src/alignment/evm_trace";
import { CreateInfo, ReturnInfo } from "../../src/alignment/evm_trace/transformers";

const sol2maruirScenarios: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.json"));

/**
 * Tests for the EvmTracer
 */
describe("EVM Tracer tests", () => {
    for (const sample of sol2maruirScenarios) {
        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            const common = getCommon();
            const state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const txData = txDescToTxData(txDesc);
                const blockData = txDescToBlockData(txDesc, common);
                const [evmTrace] = await replayEVM(
                    artifactManager,
                    state,
                    txData,
                    blockData,
                    sender
                );

                for (let i = 0; i < evmTrace.length; i++) {
                    if (i > 0 && evmTrace[i].depth > evmTrace[i - 1].depth) {
                        const createInfo = evmTrace[i - 1].createInfo as CreateInfo;
                        expect(createInfo).toBeDefined();
                        expect(createInfo.address.toString()).toEqual(
                            evmTrace[i].address.toString()
                        );
                    }

                    if (isReturn(evmTrace[i])) {
                        const retInfo = evmTrace[i].returnInfo as ReturnInfo;
                        expect(retInfo).toBeDefined();
                        expect(
                            i === evmTrace.length - 1 ||
                                evmTrace[i + 1].depth === evmTrace[i].depth - 1
                        ).toBeTruthy();
                    }

                    if (
                        i > 0 &&
                        evmTrace[i - 1].depth > evmTrace[i].depth &&
                        !isReturn(evmTrace[i - 1])
                    ) {
                        expect(evmTrace[i - 1].exceptionInfo).toBeDefined();
                    }

                    if (i > 0 && evmTrace[i - 1].depth > evmTrace[i].depth) {
                        expect(evmTrace[i].depth === evmTrace[i - 1].depth - 1);
                    }
                }
            }
        });
    }
});
