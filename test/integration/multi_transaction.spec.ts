import { loadSamples } from "../unit/utils";
import { TransactionDesc, TransactionSet } from "../unit/transaction_set";
import { basename, dirname } from "path";
import { ppTrace } from "../../src/interp/pp";

const samples: Array<[string, TransactionDesc[]]> = [
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
                    tag: "call_success",
                    returns: [
                        1n,
                        new Uint8Array([1, 2, 3]),
                        [12n, [5n, 6n], 12n],
                        new Uint8Array([0xde, 0xad, 0xbe, 0xef])
                    ]
                }
            }
        ]
    ],
    [
        "test/samples/multi_transaction/state_revert.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 11n
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                }
            }
        ]
    ],
    [
        "test/samples/multi_transaction/libraries.sol",
        [
            {
                type: "deploy",
                contract: "Lib1",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 0n
            },
            {
                type: "deploy",
                contract: "Lib",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 0n
            },
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 0n
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                }
            }
        ]
    ]
];

/**
 * Set of tests from the older sol2maruir repo. All tests define an __IRTest__ class with an entrypoint `main()`
 */
describe("Multi-transaction tests", () => {
    for (const [file, transactions] of samples) {
        it(`${file}`, async () => {
            const [artifactManager] = await loadSamples([basename(file)], dirname(file));

            const tset = new TransactionSet(artifactManager, transactions);
            const res = tset.run();

            if (!res) {
                console.error(ppTrace(tset.trace(), artifactManager));
            }

            expect(res).toBeTruthy();
        });
    }
});
