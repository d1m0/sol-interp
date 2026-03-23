import {
    Address,
    bigIntToBytes,
    createAccount,
    createAddressFromString,
    setLengthLeft
} from "@ethereumjs/util";
import { AccountMap } from "../../interp/env";
import { createTx, TypedTransaction, TypedTxData } from "@ethereumjs/tx";
import { Block, BlockData, createBlock } from "@ethereumjs/block";
import { Common, Hardfork, Mainnet, StateManagerInterface } from "@ethereumjs/common";
import { MerkleStateManager } from "@ethereumjs/statemanager";
import { RunTxResult } from "@ethereumjs/vm";
import { EVMStep, EVMTracer } from "./tracer";
import { BasicStepInfo, ImmMap, OPCODES, OpInfo } from "sol-dbg";
import { WithExceptionInfo } from "./transformers";
import { isCall, isCreate } from "./utils";
import { assert } from "../../utils";

/**
 * Build a `MerkleStateManager` corresponding to the provided `initialState`.
 * @param initialState
 * @returns
 */
async function makeStateManager(initialState: AccountMap): Promise<MerkleStateManager> {
    const state = new MerkleStateManager();
    await state.checkpoint();

    for (const [addressStr, accountInfo] of initialState.entries()) {
        const nonce = accountInfo.nonce;
        const balance = accountInfo.balance;
        const codeBuf = accountInfo.deployedBytecode;
        const storage = accountInfo.storage;

        const address = createAddressFromString(addressStr);

        const acct = createAccount({
            nonce: BigInt(nonce),
            balance: BigInt(balance)
        });

        await state.putAccount(address, acct);

        for (const [key, valBuf] of storage.entries()) {
            const keyBuf = setLengthLeft(bigIntToBytes(key), 32);

            await state.putStorage(address, keyBuf, valBuf);
        }

        await state.putCode(address, codeBuf);
    }

    await state.commit();
    await state.flush();

    return state;
}

export function getCommon(): Common {
    return new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
}

function makeFakeTransaction(
    txData: TypedTxData,
    sender: Address,
    common: Common
): TypedTransaction {
    const tx = createTx(txData, { common, freeze: false });

    /**
     *  Fake the signature
     */
    tx.getSenderAddress = () => sender;
    tx.isSigned = () => true;
    return tx;
}

/**
 * Description of a sequence of EVM Txs to replay.
 * Includes the block under which they live, and the optional initial state
 */
export interface EVMReplayDesc {
    block: Block;
    initialState?: StateDesc;
    txs: TypedTransaction[];
}

export async function makeEVMReplayDesc(
    blockData: BlockData,
    txDatas: Array<[Address, TypedTxData]>,
    initialState: AccountMap
): Promise<EVMReplayDesc> {
    const common = getCommon();
    const block = createBlock(blockData, { common });
    const stateManager = await makeStateManager(initialState);
    const liveAccounts = new Set([...initialState.entries()].map((t) => t[0]));
    const txs: TypedTransaction[] = txDatas.map(([sender, txData]) =>
        makeFakeTransaction(txData, sender, common)
    );

    return {
        block,
        initialState: {
            state: stateManager,
            liveAccounts
        },
        txs
    };
}

export interface StateDesc {
    state: StateManagerInterface;
    liveAccounts: Set<string>;
}

/**
 * The resulting info about an EVM TX Replay
 */
export interface TxReplayInfo {
    stateBefore: StateDesc;
    tx: TypedTransaction;
    result: RunTxResult;
    stateAfter: StateDesc;
    trace: EVMStep[];
}

/**
 * The resulting info about a group of TXs under a single block being replayed
 */
export interface BlockReplayInfo {
    block: Block;
    txs: TxReplayInfo[];
}

function computeLiveContracts(
    trace: Array<OpInfo & BasicStepInfo & WithExceptionInfo>,
    initialLive: Set<string>
): Set<string> {
    let res = ImmMap.fromEntries([...initialLive].map((addr) => [addr, 1]));
    const stepToSet = new Map<number, ImmMap<string, number>>();

    for (let i = 1; i < trace.length; i++) {
        const step = trace[i];
        const lastStep = trace[i - 1];

        if (isCall(step) || isCreate(step)) {
            stepToSet.set(i, res);
        }

        if (isCreate(lastStep) && !lastStep.exceptionInfo) {
            res = res.set(step.address.toString(), 1);
        } else if (lastStep.op.opcode === OPCODES.SELFDESTRUCT && !lastStep.exceptionInfo) {
            res = res.delete(lastStep.address.toString());
        }

        if (lastStep.exceptionInfo) {
            const contractsBeforeFailingCall = stepToSet.get(lastStep.exceptionInfo.correspCallIdx);
            assert(contractsBeforeFailingCall !== undefined, ``);
            res = contractsBeforeFailingCall;
        }
    }

    return new Set([...res.entries()].map((t) => t[0]));
}

export class EVMReplay {
    private _history: BlockReplayInfo[] = [];
    private _curState!: StateDesc;

    get history(): BlockReplayInfo[] {
        return this._history;
    }

    private constructor() {}

    static async replay(blocks: EVMReplayDesc[]): Promise<EVMReplay> {
        const res = new EVMReplay();
        if (blocks.length === 0) {
            return res;
        }

        res._curState =
            blocks[0].initialState !== undefined
                ? blocks[0].initialState
                : {
                      state: new MerkleStateManager(),
                      liveAccounts: new Set()
                  };

        for (const info of blocks) {
            const histEntry: BlockReplayInfo = {
                block: info.block,
                txs: []
            };

            for (const tx of info.txs) {
                const tracer = new EVMTracer();
                const [trace, result, stateAfter] = await tracer.debugTx(
                    tx,
                    info.block,
                    res._curState.state,
                    {
                        callStack: [-1]
                    }
                );

                await (stateAfter as MerkleStateManager).flush();
                const liveAccountsAfter = computeLiveContracts(trace, res._curState.liveAccounts);

                if (result.createdAddress !== undefined) {
                    liveAccountsAfter.add(result.createdAddress.toString());
                }

                histEntry.txs.push({
                    stateBefore: res._curState,
                    tx: tx,
                    result,
                    stateAfter: {
                        state: stateAfter,
                        liveAccounts: liveAccountsAfter
                    },
                    trace
                });

                res._curState = {
                    state: stateAfter,
                    liveAccounts: liveAccountsAfter
                };
            }

            res._history.push(histEntry);
        }

        return res;
    }
}

export async function replayEVM(
    initialState: AccountMap,
    txData: TypedTxData,
    blockData: BlockData,
    sender: Address
): Promise<[EVMStep[], RunTxResult, StateManagerInterface, Block, TypedTransaction]> {
    const common = getCommon();
    const tx = makeFakeTransaction(txData, sender, common);

    const block = createBlock(blockData, { common });
    const stateManager = await makeStateManager(initialState);

    const tracer = new EVMTracer();
    const [trace, res, stateAfter] = await tracer.debugTx(tx, block, stateManager, {
        callStack: [-1]
    });

    await (stateAfter as MerkleStateManager).flush();

    return [trace, res, stateAfter, block, tx];
}
