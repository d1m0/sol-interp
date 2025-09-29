import { loadSamples } from "../unit/utils";
import { TransactionSet } from "../unit/transaction_set";
import { createAddressFromString } from "@ethereumjs/util";
import * as fse from "fs-extra";
import { ppTrace } from "../../src/interp/pp";

const IRTestAddress = createAddressFromString("0x93a5b04040b9d24ea0bb4aaa19967294bcbf44d2");
const sol2maruirTests: string[] = fse.readdirSync("test/samples/sol2maruir");

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Old Sol2Marir test", () => {
    for (const sample of sol2maruirTests) {
        it(`${sample}`, async () => {
            const [artifactManager] = await loadSamples([sample], "test/samples/sol2maruir");
            const tset = new TransactionSet(artifactManager, [
                {
                    type: "deploy",
                    contract: "__IRTest__",
                    method: "",
                    args: [],
                    result: { tag: "create_success", newAddress: IRTestAddress }
                },
                {
                    type: "call",
                    contract: "__IRTest__",
                    method: "main",
                    args: [],
                    result: { tag: "call_success", returns: [] }
                }
            ]);

            const res = tset.run();
            if (!res) {
                console.error(`Trace: `, ppTrace(tset.getTrace(), artifactManager));
            }
            expect(res).toBeTruthy();
        });
    }
});
