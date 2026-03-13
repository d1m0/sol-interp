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
