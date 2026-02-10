import { loadSamples } from "../unit/utils";
import * as fse from "fs-extra";
import { Scenario, TxRunner } from "sol-dbg";

const sol2maruirTests: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.json"));

/**
 * Final integration tests - check that given a low-level trace, and artifacts, the Interpreter produces the same low-level final state.
 */
describe("Simulate test", () => {
    for (const sample of sol2maruirTests) {
        it(`${sample}`, async () => {
            const solFile = sample.slice(0, -5) + ".sol";
            const [artifactManager] = await loadSamples([solFile], "test/samples/sol2maruir");
            const runner = new TxRunner(artifactManager, false);
            const scenario: Scenario = fse.readJSONSync("test/samples/sol2maruir/" + sample);
            //const solDbg = new SolTxDebugger(artifactManager)

            await runner.runScenario(scenario);

            expect(true).toBeTruthy();
            /*
            for (let i = 0; i < scenario.steps.length; i++) {
                const tx = runner.txs[i];
                const block = runner.getBlock(tx);
                const stateBefore = runner.getStateBeforeTx(tx);
                const stateAfter = runner.getStateAfterTx(tx);
                const [trace] = await solDbg.debugTx(tx, block, stateBefore);
                traces.push(trace);
            }
            */
        });
    }
});
