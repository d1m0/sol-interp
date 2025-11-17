import { loadSamples } from "../unit/utils";
import { TransactionDesc, TransactionSet } from "../unit/transaction_set";
import { basename, dirname } from "path";
import { ppTrace } from "../../src/interp/pp";
import { createAddressFromString, hexToBytes } from "@ethereumjs/util";

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
    ],
    [
        "test/samples/multi_transaction/address_fields.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 13n
            },
            {
                type: "call",
                contract: "Foo",
                method: "code",
                args: [],
                result: {
                    tag: "call_success",
                    returns: [
                        hexToBytes(
                            "0x608060405234801561000f575f5ffd5b506004361061003f575f3560e01c806324c12bf614610043578063a9e954b914610061578063b69ef8a81461007f575b5f5ffd5b61004b61009d565b604051610058919061016b565b60405180910390f35b6100696100d6565b60405161007691906101a3565b60405180910390f35b6100876100f4565b60405161009491906101d4565b60405180910390f35b60603073ffffffffffffffffffffffffffffffffffffffff16803b806020016040519081016040528181525f908060200190933c905090565b5f3073ffffffffffffffffffffffffffffffffffffffff163f905090565b5f47905090565b5f81519050919050565b5f82825260208201905092915050565b8281835e5f83830152505050565b5f601f19601f8301169050919050565b5f61013d826100fb565b6101478185610105565b9350610157818560208601610115565b61016081610123565b840191505092915050565b5f6020820190508181035f8301526101838184610133565b905092915050565b5f819050919050565b61019d8161018b565b82525050565b5f6020820190506101b65f830184610194565b92915050565b5f819050919050565b6101ce816101bc565b82525050565b5f6020820190506101e75f8301846101c5565b9291505056fea26469706673582212200495e6b9e8a2354117d097f7edd49a2e251466266d01dd96de54e73e7a94b1d264736f6c634300081c0033"
                        )
                    ]
                }
            },
            {
                type: "call",
                contract: "Foo",
                method: "codehash",
                args: [],
                result: {
                    tag: "call_success",
                    returns: [
                        hexToBytes(
                            "0xdb9a04bd5591a007a453815c39684d2ad2ee25178b374f84a7786a3af3f62b29"
                        )
                    ]
                }
            },
            {
                type: "call",
                contract: "Foo",
                method: "balance",
                args: [],
                result: {
                    tag: "call_success",
                    returns: [13n]
                }
            }
        ]
    ],
    [
        "test/samples/multi_transaction/address_fields_delegate.sol",
        [
            {
                type: "deploy",
                contract: "Lib",
                method: "",
                args: [],
                result: {
                    tag: "create_success",
                    newAddress: createAddressFromString(
                        "0x93a5b04040b9d24ea0bb4aaa19967294bcbf44d2"
                    )
                },
                value: 0n
            },
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 13n
            },
            {
                type: "call",
                contract: "Foo",
                method: "checkAddressFields",
                args: [
                    13n,
                    hexToBytes(
                        "0x608060405234801561000f575f5ffd5b5060043610610029575f3560e01c806327544d271461002d575b5f5ffd5b61004760048036038101906100429190610297565b61005d565b6040516100549190610363565b60405180910390f35b60607393a5b04040b9d24ea0bb4aaa19967294bcbf44d26327544d278585856040518463ffffffff1660e01b815260040161009a939291906103e9565b5f60405180830381865af41580156100b4573d5f5f3e3d5ffd5b505050506040513d5f823e3d601f19601f820116820180604052508101906100dc9190610493565b509392505050565b5f604051905090565b5f5ffd5b5f5ffd5b5f819050919050565b610107816100f5565b8114610111575f5ffd5b50565b5f81359050610122816100fe565b92915050565b5f5ffd5b5f5ffd5b5f601f19601f8301169050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b61017682610130565b810181811067ffffffffffffffff8211171561019557610194610140565b5b80604052505050565b5f6101a76100e4565b90506101b3828261016d565b919050565b5f67ffffffffffffffff8211156101d2576101d1610140565b5b6101db82610130565b9050602081019050919050565b828183375f83830152505050565b5f610208610203846101b8565b61019e565b9050828152602081018484840111156102245761022361012c565b5b61022f8482856101e8565b509392505050565b5f82601f83011261024b5761024a610128565b5b813561025b8482602086016101f6565b91505092915050565b5f819050919050565b61027681610264565b8114610280575f5ffd5b50565b5f813590506102918161026d565b92915050565b5f5f5f606084860312156102ae576102ad6100ed565b5b5f6102bb86828701610114565b935050602084013567ffffffffffffffff8111156102dc576102db6100f1565b5b6102e886828701610237565b92505060406102f986828701610283565b9150509250925092565b5f81519050919050565b5f82825260208201905092915050565b8281835e5f83830152505050565b5f61033582610303565b61033f818561030d565b935061034f81856020860161031d565b61035881610130565b840191505092915050565b5f6020820190508181035f83015261037b818461032b565b905092915050565b61038c816100f5565b82525050565b5f82825260208201905092915050565b5f6103ac82610303565b6103b68185610392565b93506103c681856020860161031d565b6103cf81610130565b840191505092915050565b6103e381610264565b82525050565b5f6060820190506103fc5f830186610383565b818103602083015261040e81856103a2565b905061041d60408301846103da565b949350505050565b5f610437610432846101b8565b61019e565b9050828152602081018484840111156104535761045261012c565b5b61045e84828561031d565b509392505050565b5f82601f83011261047a57610479610128565b5b815161048a848260208601610425565b91505092915050565b5f602082840312156104a8576104a76100ed565b5b5f82015167ffffffffffffffff8111156104c5576104c46100f1565b5b6104d184828501610466565b9150509291505056fea2646970667358221220bfa97363ce6f8edd744f47480ebbe9915bb6cd04680914b3161c77925ee990df64736f6c634300081c0033"
                    ),
                    hexToBytes("0xf8cd5ba9ea959c42907e210c1f1c727e8e2b256998fe6f4f1549d9697dae1c29")
                ],
                result: {
                    tag: "call_success",
                    returns: [new Uint8Array()]
                }
            }
        ]
    ],
    [
        "test/samples/multi_transaction/mixed_function_call_options.sol",
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
        "test/samples/multi_transaction/code_in_constructor.sol",
        [
            {
                type: "deploy",
                contract: "ConstructorCode",
                method: "",
                args: [],
                result: { tag: "create_success" },
                value: 11n
            },
            {
                type: "call",
                contract: "ConstructorCode",
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
        "test/samples/multi_transaction/address_call.sol",
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
        "test/samples/multi_transaction/transfer.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
            }
        ]
    ],
    [
        "test/samples/multi_transaction/send.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
            }
        ]
    ],
    [
        "test/samples/multi_transaction/delegatecall.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
            }
        ]
    ],
    [
        "test/samples/multi_transaction/staticcall.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
            }
        ]
    ],
    [
        "test/samples/multi_transaction/delegatecall_nonce.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: [createAddressFromString("0xd5da07ddbc00bd592642628e1e032af770ccc706")]
                }
            }
        ]
    ],
    [
        "test/samples/multi_transaction/throw.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
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
        "test/samples/multi_transaction/cd_slices.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
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
        "test/samples/multi_transaction/modify_return_in_modifier_invocation.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
            }
        ]
    ],
    [
        "test/samples/multi_transaction/modify_args_and_state_in_base_constructor_invocation.sol",
        [
            {
                type: "deploy",
                contract: "Foo",
                method: "",
                args: [],
                result: { tag: "create_success" }
            },
            {
                type: "call",
                contract: "Foo",
                method: "main",
                args: [],
                result: {
                    tag: "call_success",
                    returns: []
                },
                value: 111n
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
