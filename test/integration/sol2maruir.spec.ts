import { loadSamples } from "../unit/utils";
import { TransactionDesc, TransactionSet } from "../unit/transaction_set";
import * as fse from "fs-extra";
import { ppTrace } from "../../src/interp/pp";

const sol2maruirTests: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.sol"));

const libDependencies = new Map<string, string[]>([
    ["PackedEncodingTest.config.sol", ["BytesLib"]],
    ["EncodingWithSelectorOrSignature.config.sol", ["BytesLib"]],
    ["LibToLibCall.config.sol", ["Test"]],
    ["LibraryThis.config.sol", ["GetThis"]],
    ["PublicGetterSelectorAccess.config.sol", ["BytesLib"]],
    ["EncodingWithSelectorOrSignature.config.sol", ["BytesLib"]],
    ["SelectorTest062.config.sol", ["TestLibrary"]],
    ["using_for_functions.config.sol", ["Lib"]]
]);

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Old Sol2Marir test", () => {
    for (const sample of sol2maruirTests) {
        it(`${sample}`, async () => {
            const [artifactManager] = await loadSamples([sample], "test/samples/sol2maruir");
            const txs: TransactionDesc[] = [
                {
                    type: "deploy",
                    contract: "__IRTest__",
                    method: "",
                    args: [],
                    result: { tag: "create_success" }
                },
                {
                    type: "call",
                    contract: "__IRTest__",
                    method: "main",
                    args: [],
                    result: { tag: "call_success", returns: [] },
                    value: 1000000n
                }
            ];

            if (libDependencies.has(sample)) {
                for (const libName of libDependencies.get(sample) as string[]) {
                    txs.unshift({
                        type: "deploy",
                        contract: libName,
                        method: "",
                        args: [],
                        result: { tag: "create_success" }
                    });
                }
            }

            const tset = new TransactionSet(artifactManager, txs);
            const res = tset.run();

            if (!res) {
                console.error(ppTrace(tset.getTrace(), artifactManager));
            }
            expect(res).toBeTruthy();
        });
    }
});
