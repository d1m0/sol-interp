import { Address, bytesToHex, equalsBytes, hexToBytes } from "@ethereumjs/util";
import { assert } from "../utils";
import axios from "axios";
import * as sol from "solc-typed-ast";
import { JSONCache } from "./json";
import { PartialSolcOutput } from "sol-dbg";
import { addSourcesToResult } from "./utils";
import { record } from "./stats";
import {
    BytecodeTemplate,
    matchesTemplate
} from "sol-dbg/dist/debug/artifact_manager/bytecode_templates";
import { join } from "path";

export interface EtherscanSourceResponse {
    ABI: string;
    CompilerType: string;
    CompilerVersion: string;
    ConstructorArguments: string;
    ContractFileName: string;
    ContractName: string;
    EVMVersion: string;
    Implementation: string;
    Library: string;
    LicenseType: string;
    OptimizationUsed: string;
    Proxy: string;
    Runs: string;
    SimilarMatch: string;
    SourceCode: string;
    SwamSource: string;
}

async function etherscanJSONCall(
    apiKey: string,
    action: string,
    params: { [key: string]: any },
    module: string = "contract",
    chainId: number = 1
): Promise<any> {
    const res = await axios.get(`https://api.etherscan.io/v2/api`, {
        params: {
            apiKey,
            chainId,
            module,
            action,
            ...params
        }
    });

    if (res.status !== 200) {
        throw new Error(`HTTP Error: ${res.status}`);
    }

    const jsonRes = res.data;

    if (
        (jsonRes.status !== undefined && Number(jsonRes.status) !== 1) ||
        (jsonRes.message !== undefined && jsonRes.message !== "OK")
    ) {
        throw new Error(
            `Invalid status or message in response from Etherscan action ${action}: ${JSON.stringify(jsonRes)}`
        );
    }

    if (jsonRes.result instanceof Array && jsonRes.result.length === 1) {
        return jsonRes.result[0];
    }

    return jsonRes.result;
}

class EtherscanGetSourcecodeCache extends JSONCache<EtherscanSourceResponse> {
    constructor(cacheDir: string) {
        super(cacheDir, 2);
    }

    makeKey(apiKey: string, address: string): string {
        return address;
    }

    async make(apiKey: string, address: string): Promise<EtherscanSourceResponse> {
        return etherscanJSONCall(apiKey, "getsourcecode", { address: address });
    }
}

const ETHERSCAN_CACHE_DIR = ".etherscan_cache/";
const eCache = new EtherscanGetSourcecodeCache(ETHERSCAN_CACHE_DIR);

async function getEtherscanSourceInfo(
    address: Address | string,
    apiKey: string
): Promise<EtherscanSourceResponse> {
    return await eCache.get(apiKey, address instanceof Address ? address.toString() : address);
}

export interface EtherscanContractCreationResponse {
    contractAddress: `0x${string}`;
    contractCreator: `0x${string}`;
    txHash: `0x${string}`;
    blockNumber: string;
    timestamp: string;
    contractFactory: `0x${string}` | "";
    creationBytecode: `0x${string}`;
}

class EtherscanGetContractCreationCache extends JSONCache<EtherscanContractCreationResponse> {
    constructor(cacheDir: string) {
        super(join(cacheDir, "getcontractcreation"), 2);
    }

    makeKey(apiKey: string, address: string): string {
        return address;
    }

    async make(apiKey: string, address: string): Promise<EtherscanContractCreationResponse> {
        return etherscanJSONCall(apiKey, "getcontractcreation", {
            contractaddresses: address
        });
    }
}

const eCreationCache = new EtherscanGetContractCreationCache(ETHERSCAN_CACHE_DIR);

export async function getEtherscanContractCreation(
    address: Address | string,
    apiKey: string
): Promise<EtherscanContractCreationResponse> {
    return await eCreationCache.get(
        apiKey,
        address instanceof Address ? address.toString() : address
    );
}

class EtherscanGetCode extends JSONCache<`0x{string}`> {
    constructor(cacheDir: string) {
        super(join(cacheDir, "bytecode"), 2);
    }

    makeKey(apiKey: string, address: string): string {
        return address;
    }

    async make(apiKey: string, address: string): Promise<EtherscanSourceResponse> {
        return etherscanJSONCall(apiKey, "eth_getCode", { address: address }, "proxy");
    }
}

const eCodeCache = new EtherscanGetCode(ETHERSCAN_CACHE_DIR);

async function getCode(address: string | Address, apiKey: string): Promise<Uint8Array> {
    const resp = await eCodeCache.get(
        apiKey,
        address instanceof Address ? address.toString() : address
    );
    return hexToBytes(resp);
}

const versionRE =
    /v?([0-9]+\.[0-9]+\.[0-9]+)(\+commit\.([0-9a-f]+)|-[0-9]*-[0-9]*-[0-9]*-[0-9a-fA-F]*)/;

function getCompilerVersion(raw: string): string {
    const m = raw.match(versionRE);

    if (m === null) {
        throw new Error(`Couldn't parse version string ${raw} from etherscan`);
    }

    return m[1];
}

function tryGetInputJSON(srcStr: string, settings: any): any {
    try {
        let jsonRes = JSON.parse(srcStr);
        if (!("language" in jsonRes)) {
            jsonRes = {
                language: "Solidity",
                sources: jsonRes,
                settings
            };
        }

        if (!("settings" in jsonRes)) {
            jsonRes.settings = {};
        }

        return jsonRes;
    } catch (e) {
        if (srcStr.startsWith("{{") && srcStr.endsWith("}}")) {
            try {
                const jsonRes = JSON.parse(srcStr.slice(1, -1));
                return jsonRes;
            } catch (e) {
                // nothing to do
            }
        }
        // nothing to do
    }

    return undefined;
}

interface PartialSolcInput {
    settings?: {
        libraries?: {
            [fileName: string]: {
                [contractName: string]: string;
            };
        };
    };
}

export interface CompiledArtifact {
    artifact: PartialSolcOutput;
    fileName: string;
    contractName: string;
    input?: PartialSolcInput;
}

/**
 * Cache for the compilation step
 */
class ArtifactCache extends JSONCache<CompiledArtifact | null> {
    makeKey(address: Address | string): string {
        return address instanceof Address ? address.toString() : address;
    }
    async make(
        address: Address | string,
        etherscanAPIKey: string
    ): Promise<CompiledArtifact | null> {
        return getArtifact(address, etherscanAPIKey);
    }
}

const ERC1167Template: BytecodeTemplate = {
    object: hexToBytes(
        "0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3"
    ),
    skipRanges: [[10, 30]] // bytes 10-29 inclusive
};

/**
 * Given a contract deployed bytecode try and match it as an ERC1167 proxy. If successful return
 * the proxy target address. Otherwise return undefined.
 * @param bytecode
 */
export function tryMatchERC1167(bytecode: Uint8Array): Address | undefined {
    if (matchesTemplate(bytecode, ERC1167Template, false)) {
        return new Address(bytecode.slice(10, 30));
    }

    return undefined;
}

/**
 * In some contracts (e.g. 0xab45c5a4b0c941a2f231c04c3f49182e1a254052) etherscan's fileName is empty, even though we have input JSON and a
 * a contractName that is visible in that JSON. Fix up those cases here.
 * @param artifact
 * @param contractName
 */
function detectFileName(artifact: any, contractName: string): string | undefined {
    const res: string[] = [];

    for (const fileName in artifact.contracts) {
        for (const cName in artifact.contracts[fileName]) {
            if (cName === contractName) {
                res.push(fileName);
            }
        }
    }

    return res.length === 1 ? res[0] : undefined;
}

function getFileName(result: EtherscanSourceResponse): string {
    if (result.ContractFileName !== "" && result.ContractFileName !== undefined) {
        return result.ContractFileName;
    }

    if (result.ContractName) {
        return result.ContractName;
        //return result.ContractName.endsWith(".sol") ? result.ContractName : result.ContractName + '.sol'
    }

    return `Contract.sol`;
}

/**
 * Given a locally compiled `artifact` lookup the actual deployed/creation bytecodes on chain,
 * and if they differ from the local artifact, but are close enough (as a hack, we just consider same length)
 * then replace the artifact's bytecodes with the on-chain ones.
 *
 * Note: This is hacky, but seems to work. Whenever I've seen a difference in bytecodes but same length,
 * its due to different compiler MD hashes embedded in the bytecode.
 *
 * Returns `true` if the compiled code matches, or we successfully fixed it up from on-chain
 * Returns `false` if the compiled code doesnt match and we werent able to patch it up
 */
async function fixUpBytecode(
    artifact: PartialSolcOutput,
    fileName: string,
    contractName: string,
    address: Address | string,
    apiKey: string
): Promise<boolean> {
    const mainContract = artifact.contracts[fileName][contractName];

    if (mainContract === undefined) {
        return true;
    }

    let compiledBytecode: Uint8Array;
    try {
        compiledBytecode = hexToBytes(`0x${mainContract.evm.deployedBytecode.object}`);
    } catch (e) {
        if (e instanceof RangeError) {
            record(`bad_bytecode_chars`, address.toString());
            return false;
        } else {
            throw e;
        }
    }

    const onChainBytecode = await getCode(address, apiKey);

    // Compiled bytecode matches on-chain bytecode
    if (equalsBytes(compiledBytecode, onChainBytecode)) {
        return true;
    }

    // On-chain bytecode and compiled bytecode dont even have the same length -
    // there is a structural difference and we cant match them up
    if (compiledBytecode.length !== onChainBytecode.length) {
        return false;
    }

    const onChainCreationResp = await getEtherscanContractCreation(address, apiKey);

    // @todo when `creationBytecode` is empty that usually means that `onChianCreationResp.contractFactory`
    // is set. I think this corresponds to creations in inner TXs? Handle this case separately.
    if (onChainCreationResp.creationBytecode === "0x") {
        return false;
    }

    const compiledCreationBytecode = hexToBytes(`0x${mainContract.evm.bytecode.object}`);

    mainContract.evm.bytecode.object = onChainCreationResp.creationBytecode.slice(
        2,
        compiledCreationBytecode.length * 2 + 2
    );
    mainContract.evm.deployedBytecode.object = bytesToHex(onChainBytecode).slice(2);

    return true;
}

export async function getArtifact(
    address: Address | string,
    apiKey: string
): Promise<CompiledArtifact | null> {
    const strAddr = address instanceof Address ? address.toString() : address;
    const eInfo = await getEtherscanSourceInfo(address, apiKey);
    let fileName = getFileName(eInfo);
    const settings = {
        optimizer: {
            enabled: eInfo.OptimizationUsed === "1",
            runs: Number(eInfo.Runs)
        }
    };

    let version;

    if (eInfo.SourceCode === "") {
        record(`Artifact:NoSource`, strAddr);
        return null;
    }

    try {
        version = getCompilerVersion(eInfo.CompilerVersion);
    } catch (e) {
        record(`Artifact:BadCompilerVersion`, strAddr);
        return null;
    }

    const inJson = tryGetInputJSON(eInfo.SourceCode, settings);
    if (inJson !== undefined) {
        try {
            // Force full emission over whatever settings we got from etherscan
            inJson.settings.outputSelection = {
                "*": {
                    "*": ["*"],
                    "": ["*"]
                }
            };
            const compiler = await sol.getCompilerForVersion(version, sol.CompilerKind.WASM);

            assert(
                compiler !== undefined,
                `Couldn't find wasm compiler for version ${version} for current platform`
            );

            const data = await compiler.compile(inJson);

            const errors = sol.detectCompileErrors(data);

            if (errors.length > 0) {
                throw new sol.CompileFailedError([{ compilerVersion: version, errors }]);
            }

            if (data.contracts === undefined) {
                record(`Artifact:NoContracts`, strAddr);
                throw new Error(`Compilation succeded but no contracts (ver ${version})`);
            }

            if (data.sources) {
                for (const fileName in data.sources) {
                    if (fileName in inJson.sources) {
                        data.sources[fileName].contents = inJson.sources[fileName].content;
                    }
                }
            }

            if (fileName === "dummy.sol") {
                const detectedName = detectFileName(data, eInfo.ContractName);
                if (detectedName !== undefined) {
                    record(`Artifact:MissingFileName`, strAddr);
                    fileName = detectedName;
                }
            }

            if (!(await fixUpBytecode(data, fileName, eInfo.ContractName, strAddr, apiKey))) {
                return null;
            }

            record(`Artifact:Success`, strAddr);
            return { artifact: data, fileName, contractName: eInfo.ContractName, input: inJson };
        } catch (e: any) {
            if (
                e.message !== undefined &&
                e.message.startsWith("Unsupported wasm compiler version")
            ) {
                record(`Artifact:UnsupportedWasmVersion`, strAddr);
                return null;
            }

            if (e instanceof sol.CompileFailedError) {
                for (const failure of e.failures) {
                    console.error(
                        failure.compilerVersion
                            ? `SolcJS ${failure.compilerVersion}:`
                            : "Unknown compiler:"
                    );

                    for (const error of failure.errors) {
                        console.error(error);
                    }
                }
            }

            record(`Artifact:CompileError`, strAddr);
            throw e;
        }
    }

    try {
        const { data, files } = await sol.compileSourceString(
            fileName,
            eInfo.SourceCode,
            version,
            undefined,
            [sol.CompilationOutput.ALL],
            settings
        );
        addSourcesToResult(data, files);

        if (!(await fixUpBytecode(data, fileName, eInfo.ContractName, strAddr, apiKey))) {
            return null;
        }

        record(`Artifact:Success`, strAddr);
        return { artifact: data, fileName, contractName: eInfo.ContractName };
    } catch (e: any) {
        if (e.message !== undefined && e.message.startsWith("Unsupported wasm compiler version")) {
            record(`Artifact:UnsupportedWasmVersion`, strAddr);
            return null;
        }

        if (e instanceof sol.CompileFailedError) {
            for (const failure of e.failures) {
                console.error(
                    failure.compilerVersion
                        ? `SolcJS ${failure.compilerVersion}:`
                        : "Unknown compiler:"
                );

                for (const error of failure.errors) {
                    console.error(error);
                }
            }
        }

        record(`Artifact:CompileError`, strAddr);
        throw e;
    }
}

const ARTIFACTS_CACHE_DIR = ".artifacts_cache";
const artifactCache = new ArtifactCache(ARTIFACTS_CACHE_DIR);

export async function getArtifacts(
    addresses: Iterable<Address> | Iterable<string>,
    apiKey: string
): Promise<Map<string, CompiledArtifact>> {
    const res = new Map<string, CompiledArtifact>();

    for (const addr of addresses) {
        const strAddr = addr instanceof Address ? addr.toString() : addr;

        console.error(`Try fetching source for ${strAddr}:`);
        const art = await artifactCache.get(addr, apiKey);
        if (art !== null) {
            assert(
                art.fileName in art.artifact.contracts &&
                    art.contractName in art.artifact.contracts[art.fileName],
                `Missing info for main contract {0}:{1}`,
                art.fileName,
                art.contractName
            );
            res.set(strAddr, art);
        }
    }

    return res;
}
