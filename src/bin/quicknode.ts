import { TxData, TypedTxData } from "@ethereumjs/tx";
import { AccountMap } from "../interp";
import { jsonCall } from "./json";
import { ImmMap, nyi } from "sol-dbg";
import * as fse from "fs-extra";
import * as path from "path"
import { createAddressFromString, hexToBigInt, hexToBytes } from "@ethereumjs/util";

interface QuicknodeCallTracerResult {
    type: string,
    from: `0x${string}`,
    to: `0x${string}`,
    value: `0x${string}`,
    gas: string,
    gasUsed: string,
    input: `0x${string}`,
    output: `0x${string}` | undefined,
    error: string | undefined,
    revertReason: string | undefined,
    calls: QuicknodeCallTracerResult[] | undefined;
}

interface QuicknodeAccountDesc {
    balance: `0x${string}`,
    nonce: number
    code: `0x${string}` | undefined,
    codeHash: `0x${string}` | undefined,
    storage: { [key: `0x${string}`]: `0x${string}` } | undefined
}

interface QuicknodeStateDesc {
    [address: string]: QuicknodeAccountDesc
}

const QUICKNODE_CACHE_DIR = "./quicknode_cache"

function makeAccountMap(qState: QuicknodeStateDesc): AccountMap {
    return ImmMap.fromEntries(Object.entries(qState).map(([address, accDesc]) => [address, {
        address: createAddressFromString(address),
        contract: undefined,
        deployedBytecode: accDesc.code === undefined ? new Uint8Array() : hexToBytes(accDesc.code),
        storage: ImmMap.fromEntries(accDesc.storage === undefined ? [] : Object.entries(accDesc.storage).map(([k, v]) => [hexToBigInt(k), hexToBytes(v)])),
        balance: hexToBigInt(accDesc.balance),
        nonce: BigInt(accDesc.nonce)
    }]))
}

function makeTxData(qTx: QuicknodeCallTracerResult): TypedTxData {
    return {
        to: createAddressFromString(qTx.to),
        value: hexToBigInt(qTx.value),
    }
}

/**
 * Get sufficient info from the given Quicknode `endpoint` to replay `txHash`
 * @param endpoint 
 * @param txHash 
 */
export async function getTXReplayInfo(endpoint: string, txHash: string): Promise<[TxData, AccountMap]> {
    let txData: QuicknodeCallTracerResult;
    let txPreState: QuicknodeStateDesc
    const cachePath = path.join(QUICKNODE_CACHE_DIR, `${txHash}.json`);
    if (fse.existsSync(cachePath)) {
        const cached = fse.readJsonSync(cachePath);
        txData = cached.txData;
        txPreState = cached.txPreState;
    } else {
        txData = await jsonCall(endpoint, "debug_traceTransaction", [txHash, { "tracer": "callTracer" }])
        txPreState = await jsonCall(endpoint, "debug_traceTransaction", [txHash, { "tracer": "prestateTracer" }])
        fse.writeJsonSync(cachePath, { txData, txPreState })
    }

    nyi(``)
}