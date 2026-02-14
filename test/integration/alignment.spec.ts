import { loadSamples } from "../unit/utils";
import * as fse from "fs-extra";
import {
    hexStrToBuf32,
    ImmMap,
    InitialState,
    Scenario,
    TxDesc,
    ZERO_ADDRESS_STRING
} from "sol-dbg";
import { AccountInfo, AccountMap, buildAlignedTraces } from "../../src";
import { TypedTxData } from "@ethereumjs/tx";
import { Common, Hardfork } from "@ethereumjs/common";
import { createAddressFromString, hexToBigInt, hexToBytes } from "@ethereumjs/util";
import { getCommon } from "../../src/alignment/trace_builder";
import { BlockData } from "@ethereumjs/block";

function txDescToTxData(step: TxDesc): TypedTxData {
    const txData: TypedTxData = {
        value: hexToBigInt(step.value),
        gasLimit: hexToBigInt(step.gasLimit),
        gasPrice: 8,
        data: hexToBytes(step.input),
        nonce: step.nonce
    };

    if (step.address !== ZERO_ADDRESS_STRING) {
        txData.to = createAddressFromString(step.address);
    }

    return txData;
}

function txDescToBlockData(step: TxDesc, common: Common): BlockData {
    return {
        header: {
            coinbase: step.origin,
            difficulty: common.hardfork() === Hardfork.Shanghai ? 0 : step.blockDifficulty,
            gasLimit: step.blockGasLimit,
            number: step.blockNumber,
            timestamp: step.blockTime
        }
    };
}

function scenarioInitialStateToAccountMap(initalState: InitialState): AccountMap {
    const accEntries: Array<[string, AccountInfo]> = [];
    for (const addrStr in initalState.accounts) {
        const accountDesc = initalState.accounts[addrStr as `0x{string}`];
        const storageEntries: Array<[bigint, Uint8Array]> = [];
        for (const [key, val] of Object.entries(accountDesc.storage)) {
            storageEntries.push([hexToBigInt(key as `0x{string}`), hexStrToBuf32(val)]);
        }

        accEntries.push([
            addrStr,
            {
                address: createAddressFromString(addrStr),
                contract: undefined,
                bytecode: new Uint8Array(),
                deployedBytecode: hexToBytes(accountDesc.code),
                storage: ImmMap.fromEntries(storageEntries),
                balance: hexToBigInt(accountDesc.balance),
                nonce: BigInt(accountDesc.nonce)
            }
        ]);
    }

    return ImmMap.fromEntries(accEntries);
}

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
            const [artifactManager] = await loadSamples([sample.slice(0, -4) + "sol"], "test/samples/sol2maruir");
            const common = getCommon();
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, , stateAfter] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc, common),
                    artifactManager
                );
                state = stateAfter;
                console.error(alignedTraces);
            }
        });
    }
});
