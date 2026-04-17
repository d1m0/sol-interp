import { txDescToBlockData, txDescToTxData } from "../unit/utils";
import * as fse from "fs-extra";
import { Scenario } from "sol-dbg";
import {} from "@ethereumjs/tx";
import {} from "@ethereumjs/common";
import { createAddressFromString } from "@ethereumjs/util";
import {} from "@ethereumjs/block";
import { scenarioInitialStateToAccountMap } from "../unit/utils";
import { isNonExceptionTermination, replayEVM } from "../../src/alignment/evm_trace";
import { CallInfo, CreateInfo, ReturnInfo } from "../../src/alignment/evm_trace/transformers";
import { FixedSetAsyncBlockManager } from "../../src";

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
            const state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const txData = txDescToTxData(txDesc);
                const blockData = txDescToBlockData(txDesc);
                const [evmTrace] = await replayEVM(
                    state,
                    txData,
                    blockData,
                    new FixedSetAsyncBlockManager([]),
                    sender
                );

                const stack: Array<CreateInfo | CallInfo> = [];

                for (let i = 0; i < evmTrace.length; i++) {
                    if (i > 0 && evmTrace[i].depth > evmTrace[i - 1].depth) {
                        expect(evmTrace[i].depth === evmTrace[i - 1].depth - 1);

                        const createInfo = evmTrace[i - 1].createInfo;
                        const callInfo = evmTrace[i - 1].callInfo;
                        if (createInfo) {
                            expect(createInfo.address.toString()).toEqual(
                                evmTrace[i].address.toString()
                            );
                            stack.push(createInfo);
                        } else if (callInfo) {
                            expect(callInfo.address.toString()).toEqual(
                                evmTrace[i].address.toString()
                            );
                            stack.push(callInfo);
                        } else {
                            expect(false).toBeTruthy();
                        }
                    }

                    if (isNonExceptionTermination(evmTrace[i])) {
                        const retInfo = evmTrace[i].returnInfo as ReturnInfo;
                        expect(retInfo).toBeDefined();
                        expect(
                            i === evmTrace.length - 1 ||
                                evmTrace[i + 1].depth === evmTrace[i].depth - 1
                        ).toBeTruthy();
                        expect(stack.length > 0);
                        stack.pop();
                    }

                    if (
                        i > 0 &&
                        evmTrace[i - 1].depth > evmTrace[i].depth &&
                        !isNonExceptionTermination(evmTrace[i - 1])
                    ) {
                        expect(evmTrace[i - 1].exceptionInfo).toBeDefined();
                        expect(stack.length > 0);
                        stack.pop();
                    }
                }

                expect(stack.length === 0);
            }
        });
    }
});
