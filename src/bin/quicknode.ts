import { TypedTxData } from "@ethereumjs/tx";
import { AccountMap } from "../interp";
import { JSONCache, jsonCall } from "./json";
import { ImmMap } from "sol-dbg";
import { Address, createAddressFromString, hexToBigInt, hexToBytes } from "@ethereumjs/util";
import { BlockData } from "@ethereumjs/block";

interface QuicknodeAccountDesc {
    balance: `0x${string}`;
    nonce: number;
    code: `0x${string}` | undefined;
    codeHash: `0x${string}` | undefined;
    storage: { [key: `0x${string}`]: `0x${string}` } | undefined;
}

interface QuicknodeStateDesc {
    [address: string]: QuicknodeAccountDesc;
}

interface QuicknodeTransaction {
    blockHash: `0x${string}`;
    blockNumber: `0x${string}`;
    from: `0x${string}`;
    gas: `0x${string}`;
    gasPrice: `0x${string}`;
    maxFeePerGas: `0x${string}`;
    maxPriorityFeePerGas: `0x${string}`;
    hash: `0x${string}`;
    input: `0x${string}`;
    nonce: `0x${string}`;
    to: `0x${string}`;
    transactionIndex: `0x${string}`;
    value: `0x${string}`;
    type: `0x${string}`;
    accessList: any[];
    chainId: `0x${string}`;
    v: `0x${string}`;
    r: `0x${string}`;
    s: `0x${string}`;
}

// @todo finish interface - make sure optionals are true, finish transactions, withdrawls and uncles
interface QuicknodeBlock {
    baseFeePerGas: `0x${string}`;
    blobGasUsed?: `0x${string}`;
    difficulty: `0x${string}`;
    excessBlobGas?: `0x${string}`;
    extraData: `0x${string}`;
    gasLimit: `0x${string}`;
    gasUsed: `0x${string}`;
    hash: `0x${string}`;
    logsBloom: `0x${string}`;
    miner: `0x${string}`;
    mixHash: `0x${string}`;
    nonce: `0x${string}`;
    number: `0x${string}`;
    parentBeaconBlockRoot?: `0x${string}`;
    parentHash: `0x${string}`;
    receiptsRoots: `0x${string}`;
    requestsHash?: `0x${string}`;
    sha3Uncles: `0x${string}`;
    size: `0x${string}`;
    stateRoot: `0x${string}`;
    timestamp: `0x${string}`;
    totalDifficulty: `0x${string}`;
    transactions: QuicknodeTransaction[];
    transactionsRoot: `0x${string}`;
    uncles: any[];
    withdrawls?: any[];
    withdrawlsRoot?: `0x${string}`;
}

function makeAccountMap(qState: QuicknodeStateDesc): AccountMap {
    return ImmMap.fromEntries(
        Object.entries(qState).map(([address, accDesc]) => [
            address,
            {
                address: createAddressFromString(address),
                contract: undefined,
                deployedBytecode:
                    accDesc.code === undefined ? new Uint8Array() : hexToBytes(accDesc.code),
                storage: ImmMap.fromEntries(
                    accDesc.storage === undefined
                        ? []
                        : Object.entries(accDesc.storage).map(([k, v]) => [
                            hexToBigInt(k as `0x${string}`),
                            hexToBytes(v)
                        ])
                ),
                balance: hexToBigInt(accDesc.balance),
                nonce: BigInt(accDesc.nonce)
            }
        ])
    );
}

function makeTxData(qTx: QuicknodeTransaction): TypedTxData {
    return {
        gasPrice: qTx.gasPrice,
        data: qTx.input,
        nonce: qTx.nonce,
        to: qTx.to,
        value: qTx.value,
        chainId: qTx.chainId,
        gasLimit: qTx.gas,
    };
}

function nullToUndef<T>(a: T | null): T | undefined {
    return a === null ? undefined : a;
}

function makeBlockData(qBlockData: QuicknodeBlock): BlockData {
    return {
        header: {
            parentHash: qBlockData.parentHash,
            uncleHash: qBlockData.sha3Uncles,
            coinbase: qBlockData.miner,
            stateRoot: qBlockData.stateRoot,
            transactionsTrie: qBlockData.transactionsRoot,
            receiptTrie: qBlockData.receiptsRoots,
            logsBloom: nullToUndef(qBlockData.logsBloom),
            difficulty: qBlockData.difficulty,
            number: nullToUndef(qBlockData.number),
            gasLimit: qBlockData.gasLimit,
            gasUsed: qBlockData.gasUsed,
            timestamp: qBlockData.timestamp,
            extraData: qBlockData.extraData,
            mixHash: qBlockData.mixHash,
            nonce: nullToUndef(qBlockData.nonce),
            baseFeePerGas: qBlockData.baseFeePerGas,
            withdrawalsRoot: qBlockData.withdrawlsRoot,
            blobGasUsed: qBlockData.blobGasUsed,
            excessBlobGas: qBlockData.excessBlobGas,
            parentBeaconBlockRoot: qBlockData.parentBeaconBlockRoot,
            //requestsHash: qBlockData.requestsHash
        }
    };
}

export interface QuicknodeReplayInfo {
    block: QuicknodeBlock;
    tx: QuicknodeTransaction;
    preState: QuicknodeStateDesc;
}

class QuicknodeCache extends JSONCache {
    makeKey(endpoint: string, txHash: string): string {
        return txHash
    }
    async make(endpoint: string, txHash: string): Promise<QuicknodeReplayInfo> {
        const qTxData = await jsonCall(endpoint, "eth_getTransactionByHash", [txHash]);
        const qBlockData = await jsonCall(endpoint, "eth_getBlockByNumber", [
            qTxData.blockNumber,
            false
        ]);
        const qPreState = await jsonCall(endpoint, "debug_traceTransaction", [
            txHash,
            { tracer: "prestateTracer" }
        ]);

        return {
            block: qBlockData,
            tx: qTxData,
            preState: qPreState
        };
    }
}

const QUICKNODE_CACHE_DIR = ".quicknode_cache/";
const qCache = new QuicknodeCache(QUICKNODE_CACHE_DIR)

export interface ReplayInfo {
    block: BlockData;
    tx: TypedTxData;
    preState: AccountMap;
    sender: Address
}

/**
 * Get sufficient info from the given Quicknode `endpoint` to replay `txHash`
 * @param endpoint
 * @param txHash
 */
export async function getTXReplayInfo(endpoint: string, txHash: string): Promise<ReplayInfo> {
    const rawData: QuicknodeReplayInfo = await qCache.get(endpoint, txHash);
    return {
        block: makeBlockData(rawData.block),
        tx: makeTxData(rawData.tx),
        preState: makeAccountMap(rawData.preState),
        sender: createAddressFromString(rawData.tx.from)
    }
}
