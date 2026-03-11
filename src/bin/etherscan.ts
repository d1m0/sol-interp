import { Address } from "@ethereumjs/util";
import axios from "axios";
import * as sol from "solc-typed-ast"
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
    SimilarMatch: string
    SourceCode: string;
    SwamSource: string;
}

class EtherscanCache extends JSONCache {
    makeKey(apiKey: string, address: string): string {
        return address
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

        let jsonRes = res.data

        if (Number(jsonRes.status) !== 1 || jsonRes.message !== "OK") {
            throw new Error(`Invalid status or message in response from Etherscan: ${JSON.stringify(jsonRes)}`);
        }

        if (!(jsonRes.result instanceof Array && jsonRes.result.length === 1)) {
            throw new Error(`Invalid result field in response from Etherscan: ${JSON.stringify(jsonRes)}`);
        }

        return jsonRes.result[0];
    }
}

const ETHERSCAN_CACHE_DIR = ".etherscan_cache/";
const eCache = new EtherscanCache(ETHERSCAN_CACHE_DIR)

async function getEtherscanSourceInfo(
    address: Address | string,
    apiKey: string,
): Promise<EtherscanSourceResponse> {
    return await eCache.get(apiKey, address instanceof Address ? address.toString() : address)
}

const versionRE = /v?([0-9]+\.[0-9]+\.[0-9]+)\+commit\.([0-9a-f]+)/

function getCompilerVersion(raw: string): string {
    const m = raw.match(versionRE);

    if (m === null) {
        throw new Error(`Couldn't parse version string ${raw} from etherscan`)
    }

    return m[1];
}

export async function getArtifact(
    address: Address | string,
    apiKey: string,
): Promise<[PartialSolcOutput, string, string] | undefined> {
    const eInfo = await getEtherscanSourceInfo(address, apiKey)
    if (eInfo.SourceCode === "") {
        console.error(`No source for ${address.toString()}`)
        return undefined;
    }

    try {
        const jsonRes = JSON.parse(eInfo.SourceCode);
        return jsonRes;
    } catch {
        // nothing to do
    }

    const version = getCompilerVersion(eInfo.CompilerVersion);
    const fileName = eInfo.ContractFileName === "" ? "dummy.sol" : eInfo.ContractFileName

    try {
        const { data, files } = await sol.compileSourceString(fileName, eInfo.SourceCode, version)
        addSourcesToResult(data, files);
        return [data, fileName, eInfo.ContractName];
    } catch (e: any) {
        if (e instanceof sol.CompileFailedError) {
            console.error("Compile errors encountered:");

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
