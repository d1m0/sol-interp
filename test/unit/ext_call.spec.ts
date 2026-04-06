import { Value, ImmMap, typeIdToRuntimeType, EventDesc } from "sol-dbg";
import { BaseEEI, EmitStep, FixedSetBlockManager } from "../../src";
import * as sol from "solc-typed-ast";
import * as ethABI from "web3-eth-abi";
import { loadSamples, SampleInfo, SampleMap } from "./utils";
import { AssertError } from "../../src/interp/exceptions";
import { bytesToHex, concatBytes, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { ArtifactManager } from "../../src/interp/artifactManager";
import {
    abiTypeToCanonicalName,
    abiValueToBaseValue,
    toABIEncodedType
} from "../../src/interp/abi";
import { TraceVisitor } from "../../src/interp/visitors";
import { createBlock } from "@ethereumjs/block";
import { createTx } from "@ethereumjs/tx";

type ExceptionConstructors = typeof AssertError;
const samples: Array<
    [string, string, string, Value[], Value[] | ExceptionConstructors, EventDesc[] | undefined]
> = [
    ["initial.sol", "Foo", "sqr", [2n], [4n], undefined],
    ["calls.sol", "Calls", "fib", [4n], [3n], undefined],
    ["calls.sol", "Calls", "swap", [1n, 2n], [2n, 1n], undefined],
    ["ext_call_enc_dec.sol", "Foo", "getLenCD", [hexToBytes("0x010203")], [3n], undefined],
    ["ext_call_enc_dec.sol", "Foo", "getLenMem", [hexToBytes("0x010203")], [3n], undefined],
    [
        "ext_call_enc_dec.sol",
        "Foo",
        "setByteCD",
        [hexToBytes("0x010203"), 1n, "0x04"],
        [hexToBytes("0x010403")],
        undefined
    ],
    [
        "ext_call_enc_dec.sol",
        "Foo",
        "setByteMem",
        [hexToBytes("0x010203"), 1n, "0x04"],
        [hexToBytes("0x010403")],
        undefined
    ],
    ["self_call.sol", "Foo", "main", [], [], undefined],
    ["constructor_args1.sol", "Main", "main", [], [], undefined],
    ["state_var_init.sol", "Main", "main", [], [], undefined],
    ["state_arr_assign.sol", "Foo", "main", [], [], undefined],
    ["try_catch.sol", "Foo", "main", [], [], undefined],
    ["abi_decode_fails.sol", "Foo", "main", [], [], undefined],
    [
        "events.sol",
        "Events",
        "main",
        [],
        [],
        [
            {
                topics: [
                    hexToBytes("0x92bbf6e823a631f3c8e09b1c8df90f378fb56f7fbc9701827e1ff8aad7f6a028")
                ],
                payload: hexToBytes("0x")
            },
            {
                topics: [
                    hexToBytes("0xa48a6b249a5084126c3da369fbc9b16827ead8cb5cdc094b717d3f1dcd995e29")
                ],
                payload: hexToBytes(
                    "0x0000000000000000000000000000000000000000000000000000000000000001"
                )
            },
            {
                topics: [
                    hexToBytes(
                        "0xe96585649d926cc4f5031a6113d7494d766198c0ac68b04eb93207460f9d7fd2"
                    ),
                    hexToBytes("0x0000000000000000000000000000000000000000000000000000000000000002")
                ],
                payload: hexToBytes("0x")
            },
            {
                topics: [
                    hexToBytes("0xcef08dc2fab1bd2237447bd7cf7efc4f197f159e2ce0536e0ab70cde9971adb3")
                ],
                payload: concatBytes(
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000020"
                    ),
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000003"
                    ),
                    hexToBytes("0x6162630000000000000000000000000000000000000000000000000000000000")
                )
            },
            {
                topics: [
                    hexToBytes(
                        "0xcf4bae9cff047af24e6e2099c3485ac102537023dd8af9d92d68ecd8f15e7ada"
                    ),
                    hexToBytes("0x34607c9bbfeb9c23509680f04363f298fdb0b5f9abe327304ecd1daca08cda9c")
                ],
                payload: hexToBytes("0x")
            },
            {
                topics: [
                    hexToBytes("0x9c4405817231c67b978147f4c22789316295079913f37e9dd516151ed7c448d8")
                ],
                payload: concatBytes(
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000003"
                    ),
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000040"
                    ),
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000003"
                    ),
                    hexToBytes("0x68696a0000000000000000000000000000000000000000000000000000000000")
                )
            },
            {
                topics: [
                    hexToBytes(
                        "0xd64600b716f0eac8505c8fda69ac2c1c6091fabc9e96df32877ac6afb71fe01c"
                    ),
                    hexToBytes("0x0000000000000000000000000000000000000000000000000000000000000004")
                ],
                payload: concatBytes(
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000020"
                    ),
                    hexToBytes(
                        "0x0000000000000000000000000000000000000000000000000000000000000003"
                    ),
                    hexToBytes("0x6b6c6d0000000000000000000000000000000000000000000000000000000000")
                )
            },
            {
                topics: [
                    hexToBytes(
                        "0x57b57502b043b0dd5116a3b75067a704b039b9fb373e8fed5fda6afd87341fa2"
                    ),
                    hexToBytes("0xbc7b3d96b085852f38d5e886e5a81b991302344d2a10713a313244e2eca8adda")
                ],
                payload: concatBytes(
                    hexToBytes("0x0000000000000000000000000000000000000000000000000000000000000006")
                )
            },
            {
                topics: [],
                payload: hexToBytes(`0x`)
            },
            {
                topics: [
                    hexToBytes("0x2475218b20083ebbca36b411fb871da0c9b832b081c5db0ee745b43e2e233116")
                ],
                payload: concatBytes(
                    hexToBytes("0x0000000000000000000000000000000000000000000000000000000000000007")
                )
            }
        ]
    ],
    ["array_push_lv.sol", "ArrayPushLV", "main", [], [], undefined],
    ["array_push_rv.sol", "ArrayPushRv", "main", [], [], undefined]
];

const SENDER = createAddressFromString("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97");
const RECEIVER = createAddressFromString("0x5B38Da6a701c568545dCfcB03FcB875f56beddC4");

describe("Simple function call tests", () => {
    let artifactManager: ArtifactManager;
    let sampleMap: SampleMap;

    const fileNames = [...new Set<string>(samples.map(([name]) => name))];

    beforeAll(async () => {
        [artifactManager, sampleMap] = await loadSamples(fileNames);
    }, 10000);

    for (const [fileName, contract, funName, argVals, expectedReturns, expectedEvents] of samples) {
        it(`${fileName}:${contract}.${funName}(${argVals.map((arg) => String(arg)).join(", ")})`, () => {
            const info = sampleMap.get(fileName) as SampleInfo;
            let fun: sol.FunctionDefinition | undefined = undefined;

            for (const unit of info.units) {
                fun = new sol.XPath(unit).query(
                    `//ContractDefinition[@name='${contract}']/FunctionDefinition[@name='${funName}']`
                )[0];

                if (fun !== undefined) {
                    break;
                }
            }

            sol.assert(fun !== undefined, `Couldn't find ${contract}.${funName} in ${fileName}`);

            const traceVis = new TraceVisitor();
            const chain = new BaseEEI(
                artifactManager,
                undefined,
                createBlock({}),
                createTx({}),
                new FixedSetBlockManager([])
            );

            chain.addVisitor(traceVis);
            const contractInfo = artifactManager.getContractInfo(fun);
            sol.assert(contractInfo !== undefined, `No info for contract ${contract}`);

            chain.makeEmptyAccount(SENDER, 1000000n);
            sol.assert(
                contractInfo.bytecode !== undefined && contractInfo.deployedBytecode !== undefined,
                ``
            );

            chain.setAccount(RECEIVER, {
                address: RECEIVER,
                contract: contractInfo,
                deployedBytecode: contractInfo.deployedBytecode.bytecode,
                storage: ImmMap.fromEntries([]),
                balance: 0n,
                nonce: 0n
            });

            const ctx = fun.requiredContext;

            const argTs = fun.vParameters.vParameters.map((decl) =>
                abiTypeToCanonicalName(
                    typeIdToRuntimeType(
                        sol.toABIType(sol.typeOf(decl), ctx),
                        ctx,
                        sol.DataLocation.Memory
                    )
                )
            );

            const abiRetTs = fun.vReturnParameters.vParameters.map((decl) =>
                toABIEncodedType(typeIdToRuntimeType(sol.typeOf(decl), fun.requiredContext))
            );

            const canonicalRetTNames = abiRetTs.map((retT) => abiTypeToCanonicalName(retT));

            const data = concatBytes(
                sol.signatureHash(fun),
                hexToBytes(ethABI.encodeParameters(argTs, argVals) as `0x${string}`)
            );

            const res = chain.execMsg({
                from: SENDER,
                to: RECEIVER,
                delegatingContract: undefined,
                data,
                gas: 0n,
                value: 0n,
                salt: undefined,
                isStaticCall: false,
                depth: 0
            });

            if (expectedReturns instanceof Array) {
                expect(res.reverted).toBeFalsy();
                const abiRes = ethABI.decodeParameters(canonicalRetTNames, bytesToHex(res.data));

                const decodedReturns: Value[] = [];
                for (let i = 0; i < abiRes.__length__; i++) {
                    decodedReturns.push(
                        abiValueToBaseValue(abiRes[i] as any as Value, abiRetTs[i])
                    );
                }
                /*
                console.error(`retTs: `, abiRetTs.map((t) => t.pp()))
                console.error(`abiRes: `, abiRes)
                console.error(`decodedReturns: `, decodedReturns)
                */

                expect(decodedReturns).toEqual(expectedReturns);
            } else {
                expect(res.reverted).toBeTruthy();
            }

            if (expectedEvents !== undefined) {
                const actualEvents = traceVis.trace
                    .filter((t) => t instanceof EmitStep)
                    .map((x) => (x as EmitStep).event);
                expect(actualEvents).toEqual(expectedEvents);
            }
        });
    }
});
