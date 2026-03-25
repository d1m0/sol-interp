import { Address } from "@ethereumjs/util";
import { assert } from "../utils";
import axios from "axios";
import * as sol from "solc-typed-ast";
import { JSONCache } from "./json";
import { PartialSolcOutput } from "sol-dbg";
import { addSourcesToResult, error } from "./utils";

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

const versionRE = /v?([0-9]+\.[0-9]+\.[0-9]+)\+commit\.([0-9a-f]+)/;

function getCompilerVersion(raw: string): string {
    const m = raw.match(versionRE);

    if (m === null) {
        throw new Error(`Couldn't parse version string ${raw} from etherscan`);
    }

    return m[1];
}

function tryGetInputJSON(srcStr: string): any {
    try {
        const jsonRes = JSON.parse(srcStr);
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

export async function getArtifact(
    address: Address | string,
    apiKey: string
): Promise<[PartialSolcOutput, string, string] | undefined> {
    const eInfo = await getEtherscanSourceInfo(address, apiKey);
    const fileName = eInfo.ContractFileName === "" ? "dummy.sol" : eInfo.ContractFileName;
    const settings = {
        optimizer: {
            enabled: eInfo.OptimizationUsed === "1",
            runs: Number(eInfo.Runs)
        }
    };

    const version = getCompilerVersion(eInfo.CompilerVersion);

    if (eInfo.SourceCode === "") {
        return undefined;
    }

    const inJson = tryGetInputJSON(eInfo.SourceCode);
    if (inJson !== undefined) {
        try {
            const compiler = await sol.getCompilerForVersion(version, sol.CompilerKind.WASM);

            assert(
                compiler !== undefined,
                `Couldn't find wasm compiler for version ${version} for current platform`
            );

            const data = await compiler.compile(inJson);
            const files: sol.FileMap = new Map();
            for (const [path, fileData] of Object.entries(inJson.sources)) {
                assert(false, `${path},${fileData}, ${files}`);
            }

            return [data, fileName, eInfo.ContractName];
        } catch (e: any) {
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

                error("Unable to compile due to errors above.");
            }

            error(e.message);
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

        return [data, fileName, eInfo.ContractName];
    } catch (e: any) {
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

            error("Unable to compile due to errors above.");
        }

        error(e.message);
    }
}

export async function getArtifacts(
    addresses: Iterable<Address> | Iterable<string>,
    apiKey: string
): Promise<Map<string, [PartialSolcOutput, string]>> {
    const res = new Map<string, [PartialSolcOutput, string]>();

    for (const addr of addresses) {
        const strAddr = addr instanceof Address ? addr.toString() : addr;

        console.error(`Try fetching source for ${strAddr}:`);
        const artifactDesc = await getArtifact(addr, apiKey);
        if (artifactDesc !== undefined) {
            const [artifact, fileName, contractName] = artifactDesc;
            assert(
                fileName in artifact.contracts && contractName in artifact.contracts[fileName],
                `Missing info for main contract {0}:{1}`,
                fileName,
                contractName
            );
            res.set(strAddr, [artifact, `${fileName}:${contractName}`]);
        }
    }

    return res;
}
