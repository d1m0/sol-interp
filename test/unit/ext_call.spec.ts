import { Value, ImmMap, astToRuntimeType } from "sol-dbg";
import { Chain } from "../../src";
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

type ExceptionConstructors = typeof AssertError;
const samples: Array<[string, string, string, Value[], Value[] | ExceptionConstructors]> = [
    ["initial.sol", "Foo", "sqr", [2n], [4n]],
    ["calls.sol", "Calls", "fib", [4n], [3n]],
    ["calls.sol", "Calls", "swap", [1n, 2n], [2n, 1n]],
    ["ext_call_enc_dec.sol", "Foo", "getLenCD", [hexToBytes("0x010203")], [3n]],
    ["ext_call_enc_dec.sol", "Foo", "getLenMem", [hexToBytes("0x010203")], [3n]],
    [
        "ext_call_enc_dec.sol",
        "Foo",
        "setByteCD",
        [hexToBytes("0x010203"), 1n, "0x04"],
        [hexToBytes("0x010403")]
    ],
    [
        "ext_call_enc_dec.sol",
        "Foo",
        "setByteMem",
        [hexToBytes("0x010203"), 1n, "0x04"],
        [hexToBytes("0x010403")]
    ],
    ["self_call.sol", "Foo", "main", [], []],
    ["constructor_args1.sol", "Main", "main", [], []],
    ["state_var_init.sol", "Main", "main", [], []],
    ["state_arr_assign.sol", "Foo", "main", [], []],
    ["try_catch.sol", "Foo", "main", [], []],
    ["abi_decode_fails.sol", "Foo", "main", [], []]
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

    for (const [fileName, contract, funName, argVals, expectedReturns] of samples) {
        it(`${fileName}:${contract}.${funName}(${argVals.map((arg) => String(arg)).join(", ")})`, () => {
            const info = sampleMap.get(fileName) as SampleInfo;
            const infer = new sol.InferType(info.version);

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
            const chain = new Chain(artifactManager);

            chain.addVisitor(traceVis);
            const contractInfo = artifactManager.getContractInfo(fun);
            sol.assert(contractInfo !== undefined, `No info for contract ${contract}`);

            chain.makeEOA(SENDER, 1000000n);
            chain.setAccount(RECEIVER, {
                address: RECEIVER,
                contract: contractInfo,
                bytecode: contractInfo.bytecode.bytecode,
                deployedBytecode: contractInfo.deployedBytecode.bytecode,
                storage: ImmMap.fromEntries([]),
                balance: 0n,
                nonce: 0n
            });

            const argTs = fun.vParameters.vParameters.map((decl) =>
                sol.abiTypeToCanonicalName(
                    infer.toABIEncodedType(
                        infer.variableDeclarationToTypeNode(decl),
                        sol.ABIEncoderVersion.V2
                    )
                )
            );

            const abiRetTs = fun.vReturnParameters.vParameters.map((decl) =>
                toABIEncodedType(astToRuntimeType(infer.variableDeclarationToTypeNode(decl), infer))
            );

            const canonicalRetTNames = abiRetTs.map((retT) => abiTypeToCanonicalName(retT));

            const data = concatBytes(
                hexToBytes(`0x${infer.signatureHash(fun)}`),
                hexToBytes(ethABI.encodeParameters(argTs, argVals) as `0x${string}`)
            );

            const res = chain.call({
                from: SENDER,
                to: RECEIVER,
                delegatingContract: undefined,
                data,
                gas: 0n,
                value: 0n,
                salt: undefined,
                isStaticCall: false
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
        });
    }
});
