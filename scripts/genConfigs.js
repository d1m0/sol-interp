const fse = require("fs-extra");
const sol = require("solc-typed-ast")
const util = require("@ethereumjs/util");
const { assert } = require("console");

const samples = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.sol"));
//const samples = ["SelectorTest062.config.sol"]

const libDependencies = new Map([
    ["PackedEncodingTest.config.sol", ["BytesLib"]],
    ["EncodingWithSelectorOrSignature.config.sol", ["BytesLib"]],
    ["LibToLibCall.config.sol", ["Test"]],
    ["LibraryThis.config.sol", ["GetThis"]],
    ["PublicGetterSelectorAccess.config.sol", ["BytesLib"]],
    ["EncodingWithSelectorOrSignature.config.sol", ["BytesLib"]],
    ["SelectorTest062.config.sol", ["TestLibrary"]],
    ["using_for_functions.config.sol", ["Lib"]]
]);

function fillLinkRefs(bytecodeInfo) {
    let res = bytecodeInfo.object;
    for (const fName in bytecodeInfo.linkReferences) {
        for (const cName in bytecodeInfo.linkReferences[fName]) {
            for (const ref of bytecodeInfo.linkReferences[fName][cName]) {
                const start = ref.start * 2;
                const end = start + 2 * ref.length;
                res = res.slice(0, start) + "93a5b04040b9d24ea0bb4aaa19967294bcbf44d2" + res.slice(end)
            }
        }
    }

    return res;
}

const addrsToNonce = [
    "0x93a5b04040b9d24ea0bb4aaa19967294bcbf44d2",
    "0x7e9256d3bc659166d7268d9484c1fb4eba33725e"
];

const libToAddr = new Map();

(async () => {
    for (const f of samples) {
        const fName = `test/samples/sol2maruir/${f}`
        console.error(fName)
        const res = await sol.compileSol(fName, "auto", undefined, [sol.CompilationOutput.ALL])
        const IRTest = res.data.contracts[fName]["__IRTest__"]
        assert(IRTest !== undefined)

        let nonce = 0;

        config = {
            initialState: {
                accounts: {
                    "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97": {
                        nonce: "0x0",
                        balance: "0xf4240",
                        code: "0x",
                        storage: {}
                    }
                }
            },
            steps: [
            ]
        }

        const deps = libDependencies.get(f);
        if (deps !== undefined) {
            for (const cName of deps) {
                for (const libFName in res.data.contracts) {
                    const lib = res.data.contracts[libFName][cName];
                    if (lib !== undefined) {
                        config.steps.push(
                            {
                                "address": "0x0000000000000000000000000000000000000000",
                                "gasLimit": "0xff0000",
                                "gasPrice": "0x1",
                                "input": `0x${fillLinkRefs(lib.evm.bytecode)}`,
                                "origin": "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",
                                "value": "0x0",
                                "blockCoinbase": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0",
                                "blockDifficulty": "0x0",
                                "blockGasLimit": "0xff0000",
                                "blockNumber": "0x1",
                                "blockTime": "0x1",
                                "nonce": nonce++
                            },
                        )
                    }
                }
            }
        }

        const irTestAddr = addrsToNonce[nonce];
        // Deploy __IRTest__
        config.steps.push(
            {
                "address": "0x0000000000000000000000000000000000000000",
                "gasLimit": "0xff0000",
                "gasPrice": "0x1",
                "input": `0x${fillLinkRefs(IRTest.evm.bytecode)}`,
                "origin": "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",
                "value": "0x0",
                "blockCoinbase": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0",
                "blockDifficulty": "0x0",
                "blockGasLimit": "0xff0000",
                "blockNumber": "0x1",
                "blockTime": "0x1",
                "nonce": nonce++
            },
        )
        // Call main
        config.steps.push(
            {
                "address": irTestAddr,
                "gasLimit": "0xff0000",
                "gasPrice": "0x1",
                "input": "0xdffeadd0",
                "origin": "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",
                "value": "0xf4240",
                "blockCoinbase": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0",
                "blockDifficulty": "0x0",
                "blockGasLimit": "0xff0000",
                "blockNumber": "0x1",
                "blockTime": "0x1",
                "nonce": nonce++
            }
        )

        const jsonFile = fName.slice(0, -3) + "json"
        console.error(`Overwriting ${jsonFile}`)
        fse.writeJsonSync(jsonFile, config, { spaces: 4 });
    }
})();