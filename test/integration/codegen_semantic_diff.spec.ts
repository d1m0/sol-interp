import { loadSamples } from "../unit/utils";
import { TransactionSet } from "../unit/transaction_set";
import { createAddressFromString } from "@ethereumjs/util";
import { ppTrace } from "../../src/interp/pp";

const TestAddress = createAddressFromString("0x93a5b04040b9d24ea0bb4aaa19967294bcbf44d2");
const samples: Array<[string, string]> = [
    ["codegen_init_order.old.sol", "codegen_init_order.new.sol"]
];

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Old Sol2Marir test", () => {
    for (const [oldFile, newFile] of samples) {
        for (const [fileName, settings] of [
            [oldFile, {}],
            [newFile, { viaIR: true }]
        ] as Array<[string, any]>) {
            const isOld = fileName === oldFile;
            it(`${fileName.slice(0, -8)} ${isOld ? "old" : "new"} sample`, async () => {
                const [artifactManager] = await loadSamples(
                    [[fileName, settings]],
                    "test/samples/codegen_semantic_diff"
                );

                if (!isOld) {
                    artifactManager.artifacts()[0].codegen = "ir";
                }

                const tset = new TransactionSet(artifactManager, [
                    {
                        type: "deploy",
                        contract: "Test",
                        method: "",
                        args: [],
                        result: { tag: "create_success", newAddress: TestAddress }
                    },
                    {
                        type: "call",
                        contract: "Test",
                        method: "main",
                        args: [],
                        result: { tag: "call_success", returns: [] }
                    }
                ]);

                const res = tset.run();

                if (!res) {
                    console.error(ppTrace(tset.getTrace(), artifactManager));
                }
                expect(res).toBeTruthy();
            });
        }
    }
});
