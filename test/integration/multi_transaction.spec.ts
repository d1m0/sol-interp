import { loadSamples } from "../unit/utils";
import { TransactionDesc, TransactionSet } from "../unit/transaction_set"
import { basename, dirname } from "path";

const samples: [string, TransactionDesc[]][] = [
    [
        "test/samples/multi_transaction/public_getters.sol",
        [
            {
                type: "deploy",
                contract: "ComplexPublicGetter",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "ComplexPublicGetter",
                method: "data",
                args: [1n, true, 0n],
                result: {
                    tag: "call_success", returns: [
                        1n, new Uint8Array([1, 2, 3]), [12n, [5n, 6n,], 12n], new Uint8Array([0xde, 0xad, 0xbe, 0xef])
                    ]
                }
            }
        ]
    ]
]

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Multi-transaction tests", () => {
    for (const [file, transactions] of samples) {
        it(`${file}`, async () => {
            const [artifactManager] = await loadSamples([basename(file)], dirname(file));

            const tset = new TransactionSet(artifactManager, transactions)
            expect(tset.run()).toBeTruthy()
        });
    }
})