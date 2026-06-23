import { Address, equalsBytes, hexToBytes } from "@ethereumjs/util";
import { assert } from "../utils";
import axios from "axios";
import * as sol from "solc-typed-ast";
import { JSONCache } from "./json";
import { PartialSolcOutput } from "sol-dbg";
import { record } from "./stats";
import {
    BytecodeTemplate,
    matchesTemplate
} from "sol-dbg/dist/debug/artifact_manager/bytecode_templates";
import { join } from "path";
import { getCode as qnGetCode } from "./quicknode";
import { fixArtifactBytecodes } from "./md";

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

export async function ethGetCode(address: string | Address, apiKey: string): Promise<Uint8Array> {
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
    sources: {
        [fileName: string]: {
            content: string;
        };
    };
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
        etherscanAPIKey: string,
        quicknodeEndpoint: string
    ): Promise<CompiledArtifact | null> {
        return getArtifact(address, etherscanAPIKey, quicknodeEndpoint);
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

export function isERC1167Proxy(bytecode: Uint8Array): boolean {
    return tryMatchERC1167(bytecode) !== undefined;
}

const minimalProxyBytecode = hexToBytes(
    "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3"
);

export function isMinimalProxy(bytecode: Uint8Array): boolean {
    return equalsBytes(bytecode, minimalProxyBytecode);
}

export function isProxy(bytecode: Uint8Array): boolean {
    return isMinimalProxy(bytecode) || isERC1167Proxy(bytecode);
}

function getFileName(result: EtherscanSourceResponse): string {
    if (result.ContractFileName !== "" && result.ContractFileName !== undefined) {
        return result.ContractFileName;
    }

    if (result.ContractName) {
        return result.ContractName + ".sol";
    }

    return `Contract.sol`;
}

const hexLinkRefRe = /__\$[0-9a-f]*\$__/g;
const nameLinkRefRe = /_+.*:.*_+/g;
/**
 * In older compiler versions the artifact bytecode contained sections like `_$<hex>$_` or `__FileName.sol:ContractName___` in places
 * corresponding to link references. Replace those with 0s
 * @param artifact
 */
function cleanupArtifactBytecode(artifact: PartialSolcOutput): void {
    for (const fileName in artifact.contracts) {
        for (const contractName in artifact.contracts[fileName]) {
            const contract = artifact.contracts[fileName][contractName];

            for (const bytecode of [contract.evm.bytecode, contract.evm.deployedBytecode]) {
                bytecode.object = bytecode.object.replaceAll(hexLinkRefRe, (oldStr) =>
                    "0".repeat(oldStr.length)
                );

                bytecode.object = bytecode.object.replaceAll(nameLinkRefRe, (oldStr) =>
                    "0".repeat(oldStr.length)
                );
            }
        }
    }
}

function detectFileName(baseName: string, inJson: PartialSolcInput): string {
    const res = Object.keys(inJson.sources).filter((name) => name.endsWith(baseName));
    if (res.length === 1) {
        return res[0];
    }

    return baseName;
}

export async function getArtifact(
    address: Address | string,
    apiKey: string,
    quicknodeEndpoint: string
): Promise<CompiledArtifact | null> {
    const strAddr = address instanceof Address ? address.toString() : address;
    const eInfo = await getEtherscanSourceInfo(address, apiKey);

    if (eInfo.SourceCode === "") {
        record(`Artifact:NoSource`, strAddr);
        return null;
    }

    // Get proper compiler version
    let version;
    try {
        version = getCompilerVersion(eInfo.CompilerVersion);
    } catch (e) {
        record(`Artifact:BadCompilerVersion`, strAddr);
        return null;
    }

    let compiler: sol.WasmCompiler | sol.NativeCompiler | undefined;
    try {
        compiler = await sol.getCompilerForVersion(version, sol.CompilerKind.WASM);
    } catch (e) {
        record(`Unsupported compiler version: ${version}`, strAddr);
        return null;
    }

    if (compiler === undefined) {
        record(`Unsupported compiler version: ${version}`, strAddr);
        return null;
    }

    // Build canonical input json
    let fileName = getFileName(eInfo);
    const contractName = eInfo.ContractName;

    const settings = {
        remappings: [],
        optimizer: {
            enabled: eInfo.OptimizationUsed === "1",
            runs: Number(eInfo.Runs)
        },
        libraries: {}
    };

    let inJson = tryGetInputJSON(eInfo.SourceCode, settings);
    if (inJson === undefined) {
        inJson = {
            language: "Solidity",
            sources: {
                [fileName]: {
                    content: eInfo.SourceCode
                }
            },
            settings
        };
    } else {
        fileName = detectFileName(fileName, inJson);
    }

    inJson.settings.outputSelection = {
        "*": {
            "*": ["*"],
            "": ["*"]
        }
    };

    if (!(fileName in inJson.sources)) {
        record(`cant_detect_filename`, strAddr);
        return null;
    }

    const data = await compiler.compile(inJson);

    const errors = sol.detectCompileErrors(data);

    if (errors.length > 0) {
        throw new sol.CompileFailedError([{ compilerVersion: version, errors }]);
    }

    if (data.sources) {
        for (const fileName in data.sources) {
            if (fileName in inJson.sources) {
                data.sources[fileName].contents = inJson.sources[fileName].content;
            }
        }
    }

    cleanupArtifactBytecode(data);
    const contractArtifact = data.contracts[fileName][contractName];

    sol.assert(
        contractArtifact !== undefined,
        `Missing maing contract ${fileName}:${contractName}`
    );

    sol.assert(
        contractArtifact.evm.bytecode.object !== "",
        `Unexpected non-deployable main contract ${fileName}:${contractName}`
    );

    let compiledBytecode: Uint8Array;
    try {
        compiledBytecode = hexToBytes(`0x${contractArtifact.evm.deployedBytecode.object}`);
    } catch (e) {
        if (e instanceof RangeError) {
            record(`bad_bytecode_chars`, strAddr);
        }

        throw e;
    }

    // @todo should specify a block number here. Works for now for testing
    const onChainBytecode = await qnGetCode(quicknodeEndpoint, strAddr, "latest");
    if (onChainBytecode.length !== compiledBytecode.length) {
        record(`different_lengths`, strAddr);
        return null;
    }

    if (!equalsBytes(compiledBytecode, onChainBytecode)) {
        if (!fixArtifactBytecodes(data, fileName, contractName, onChainBytecode)) {
            record(`has_non_hash_diffs`, strAddr);
            return null;
        }
    }

    return { artifact: data, fileName, contractName, input: inJson };
}

const ARTIFACTS_CACHE_DIR = ".artifacts_cache";
const artifactCache = new ArtifactCache(ARTIFACTS_CACHE_DIR);

export async function getArtifacts(
    addresses: Iterable<Address> | Iterable<string>,
    apiKey: string,
    quicknodeEndpoint: string
): Promise<Map<string, CompiledArtifact>> {
    const res = new Map<string, CompiledArtifact>();

    for (const addr of addresses) {
        const strAddr = addr instanceof Address ? addr.toString() : addr;

        console.error(`Try fetching source for ${strAddr}:`);
        const art = await artifactCache.get(addr, apiKey, quicknodeEndpoint);
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
