import { Address, hexToBytes } from "@ethereumjs/util";
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

class EtherscanCache extends JSONCache<EtherscanSourceResponse> {
    constructor(cacheDir: string) {
        super(cacheDir, 2);
    }

    makeKey(apiKey: string, address: string): string {
        return address;
    }

    async make(apiKey: string, address: string): Promise<EtherscanSourceResponse> {
        const res = await axios.get(`https://api.etherscan.io/v2/api`, {
            params: {
                apiKey,
                chainId: 1,
                module: "contract",
                action: "getsourcecode",
                address
            }
        });

        if (res.status !== 200) {
            throw new Error(`HTTP Error: ${res.status}`);
        }

        const jsonRes = res.data;

        if (Number(jsonRes.status) !== 1 || jsonRes.message !== "OK") {
            throw new Error(
                `Invalid status or message in response from Etherscan: ${JSON.stringify(jsonRes)}`
            );
        }

        if (!(jsonRes.result instanceof Array && jsonRes.result.length === 1)) {
            throw new Error(
                `Invalid result field in response from Etherscan: ${JSON.stringify(jsonRes)}`
            );
        }

        return jsonRes.result[0];
    }
}

const ETHERSCAN_CACHE_DIR = ".etherscan_cache/";
const eCache = new EtherscanCache(ETHERSCAN_CACHE_DIR);

async function getEtherscanSourceInfo(
    address: Address | string,
    apiKey: string
): Promise<EtherscanSourceResponse> {
    return await eCache.get(apiKey, address instanceof Address ? address.toString() : address);
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

interface CompiledArtifact {
    artifact?: PartialSolcOutput;
    fileName?: string;
    contractName?: string;
}

/**
 * Cache for the compilation step
 */
class ArtifactCache extends JSONCache<CompiledArtifact> {
    makeKey(address: Address | string): string {
        return address instanceof Address ? address.toString() : address;
    }
    async make(address: Address | string, etherscanAPIKey: string): Promise<CompiledArtifact> {
        const t = await getArtifact(address, etherscanAPIKey);
        if (t === undefined) {
            return {};
        }

        return {
            artifact: t[0],
            fileName: t[1],
            contractName: t[2]
        };
    }
}

const ERC1167Template: BytecodeTemplate = {
    object: hexToBytes(
        "0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3"
    ),
    skipRanges: [[10, 30]], // bytes 10-29 inclusive
    contractInfo: undefined as unknown as any
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

export async function getArtifact(
    address: Address | string,
    apiKey: string
): Promise<[PartialSolcOutput, string, string] | undefined> {
    const strAddr = address instanceof Address ? address.toString() : address;
    const eInfo = await getEtherscanSourceInfo(address, apiKey);
    const fileName = eInfo.ContractFileName === "" ? "dummy.sol" : eInfo.ContractFileName;
    const settings = {
        optimizer: {
            enabled: eInfo.OptimizationUsed === "1",
            runs: Number(eInfo.Runs)
        }
    };

    let version;

    try {
        version = getCompilerVersion(eInfo.CompilerVersion);
    } catch (e) {
        record(`Artifact:BadCompilerVersion`, strAddr);
        return undefined;
    }

    if (eInfo.SourceCode === "") {
        record(`Artifact:NoSource`, strAddr);
        return undefined;
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

            record(`Artifact:Success`, strAddr);
            return [data, fileName, eInfo.ContractName];
        } catch (e: any) {
            if (
                e.message !== undefined &&
                e.message.startsWith("Unsupported wasm compiler version")
            ) {
                record(`Artifact:UnsupportedWasmVersion`, strAddr);
                return undefined;
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

        record(`Artifact:Success`, strAddr);
        return [data, fileName, eInfo.ContractName];
    } catch (e: any) {
        if (e.message !== undefined && e.message.startsWith("Unsupported wasm compiler version")) {
            record(`Artifact:UnsupportedWasmVersion`, strAddr);
            return undefined;
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
): Promise<Map<string, [PartialSolcOutput, string]>> {
    const res = new Map<string, [PartialSolcOutput, string]>();

    for (const addr of addresses) {
        const strAddr = addr instanceof Address ? addr.toString() : addr;

        console.error(`Try fetching source for ${strAddr}:`);
        const art = await artifactCache.get(addr, apiKey);
        if (
            art.artifact !== undefined &&
            art.contractName !== undefined &&
            art.fileName !== undefined
        ) {
            assert(
                art.fileName in art.artifact.contracts &&
                    art.contractName in art.artifact.contracts[art.fileName],
                `Missing info for main contract {0}:{1}`,
                art.fileName,
                art.contractName
            );
            res.set(strAddr, [art.artifact, `${art.fileName}:${art.contractName}`]);
        }
    }

    return res;
}
