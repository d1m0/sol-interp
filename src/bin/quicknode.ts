import { TypedTxData } from "@ethereumjs/tx";
import { AccountMap, AsyncBlockManagerI } from "../interp";
import { JSONCache, jsonCall } from "./json";
import { ImmMap, toHexString } from "sol-dbg";
import { Address, createAddressFromString, hexToBigInt, hexToBytes } from "@ethereumjs/util";
import { Block, BlockData } from "@ethereumjs/block";
import { join } from "path";
import { assert, createBlock } from "../utils";

interface QuicknodeAccountDesc {
    balance: `0x${string}`;
    nonce: number | undefined;
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
                nonce: BigInt(accDesc.nonce === undefined ? 0n : accDesc.nonce)
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
        gasLimit: qTx.gas
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
            parentBeaconBlockRoot: qBlockData.parentBeaconBlockRoot
            //requestsHash: qBlockData.requestsHash
        }
    };
}

export interface QuicknodeReplayInfo {
    block: QuicknodeBlock;
    tx: QuicknodeTransaction;
    preState: QuicknodeStateDesc;
}

class QuicknodeBlockWithTxs extends JSONCache<QuicknodeBlock | undefined> {
    constructor(basePath: string) {
        super(join(basePath, "blocks_with_txs"), 5);
    }

    makeKey(endpoint: string, blockNum: number): string {
        return `${blockNum}`;
    }
    async make(endpoint: string, blockNum: number): Promise<QuicknodeBlock | undefined> {
        const res = await jsonCall(endpoint, "eth_getBlockByNumber", [toHexString(blockNum), true]);
        return res === null ? undefined : res;
    }
}

class QuicknodeTxs extends JSONCache<QuicknodeTransaction> {
    constructor(basePath: string) {
        super(join(basePath, "txs"), 5);
    }

    makeKey(endpoint: string, txHash: string): string {
        return `${txHash}`;
    }
    async make(endpoint: string, txHash: string): Promise<QuicknodeTransaction> {
        return await jsonCall(endpoint, "eth_getTransactionByHash", [txHash]);
    }
}

class QuicknodePreState extends JSONCache<QuicknodeStateDesc> {
    constructor(basePath: string) {
        super(join(basePath, "txs_pre_state"), 5);
    }

    makeKey(endpoint: string, blockNum: number): string {
        return `${blockNum}`;
    }
    async make(endpoint: string, txHash: string): Promise<QuicknodeTransaction> {
        return await jsonCall(endpoint, "debug_traceTransaction", [
            txHash,
            { tracer: "prestateTracer" }
        ]);
    }
}

const QUICKNODE_CACHE_DIR = ".quicknode_cache/";
const qBlocksWithTx = new QuicknodeBlockWithTxs(QUICKNODE_CACHE_DIR);
const qTxs = new QuicknodeTxs(QUICKNODE_CACHE_DIR);
const qPreState = new QuicknodePreState(QUICKNODE_CACHE_DIR);

export interface ReplayInfo {
    block: BlockData;
    tx: TypedTxData;
    preState: AccountMap;
    sender: Address;
    blockHash: string;
    txHash: string;
}

/**
 * Get sufficient info from the given Quicknode `endpoint` to replay `txHash`
 * @param endpoint
 * @param txHash
 */
export async function getTXReplayInfo(endpoint: string, txHash: string): Promise<ReplayInfo> {
    const tx = await qTxs.get(endpoint, txHash);
    const blockNum = hexToBigInt(tx.blockNumber);
    const qBlockData = await qBlocksWithTx.get(endpoint, blockNum);
    assert(qBlockData !== undefined, `No block with number {0}`, blockNum);
    const blockData = makeBlockData(qBlockData);

    const preState = await qPreState.get(endpoint, txHash);
    return {
        block: blockData,
        tx: makeTxData(tx),
        preState: makeAccountMap(preState),
        sender: createAddressFromString(tx.from),
        blockHash: tx.blockHash,
        txHash: tx.hash
    };
}

/**
 * Get sufficient info from the given Quicknode `endpoint` to replay all transactions in the given `blockNum`
 * @param endpoint
 * @param txHash
 */
export async function getBlockReplayInfo(
    endpoint: string,
    blockNum: number
): Promise<ReplayInfo[]> {
    const res: ReplayInfo[] = [];
    const blockData = await qBlocksWithTx.get(endpoint, blockNum);
    assert(blockData !== undefined, `No block with number {0}`, blockNum);
    const block = makeBlockData(blockData);

    for (const tx of blockData.transactions) {
        const preState = await qPreState.get(endpoint, tx.hash);
        res.push({
            block,
            tx: makeTxData(tx),
            preState: makeAccountMap(preState),
            sender: createAddressFromString(tx.from),
            blockHash: tx.blockHash,
            txHash: tx.hash
        });
    }
    return res;
}

// @todo Uncomment and use in bin/replay.ts after fixing #55
export class QuicknodeBlockManager implements AsyncBlockManagerI {
    blockCache = new Map<bigint, Block>();
    constructor(private readonly endpoint: string) {}

    getCachedBlocks(): Block[] {
        return [...this.blockCache.values()];
    }

    async getBlock(number: bigint): Promise<Block | undefined> {
        let res = this.blockCache.get(number);
        if (res !== undefined) {
            return res;
        }

        const blockData = await qBlocksWithTx.get(this.endpoint, number);
        res = blockData === undefined ? undefined : createBlock(makeBlockData(blockData));

        if (res) {
            this.blockCache.set(res.header.number, res);
        }

        return res;
    }
}
