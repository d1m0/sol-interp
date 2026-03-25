import { StateManagerInterface, StorageDump } from "@ethereumjs/common";
import { Address, hexToBigInt, setLengthLeft } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, Storage, OpInfo, ImmMap, OPCODES, wordToAddress } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { assert } from "../../../utils";
import { CreateInfo, WithCreateInfo } from "./create";
import { WithCallInfo } from "./call";
import { WithExceptionInfo } from "./exceptions";
import { WithReturnInfo } from "./return";
import { AccountInfo } from "../../../interp";
import { RLP } from "@ethereumjs/rlp";
import { TypedTransaction } from "@ethereumjs/tx";

export interface SnapshotInfo {
    changedAccounts: AccountInfo[];
    deletedAccounts: Set<string>;
}

export interface WithStateSnapshot {
    snapshotInfo: SnapshotInfo | undefined;
}

type LowerStep = BasicStepInfo &
    OpInfo &
    WithCreateInfo &
    WithCallInfo &
    WithExceptionInfo &
    WithReturnInfo;

function storageDumpToStorage(dump: StorageDump): Storage {
    const entries: Array<[bigint, Uint8Array]> = Object.entries(dump).map<[bigint, Uint8Array]>(
        ([strKey, strVal]) => {
            const decoded = RLP.decode(strVal);
            return [hexToBigInt(strKey as `0x${string}`), setLengthLeft(decoded as Uint8Array, 32)];
        }
    );
    return ImmMap.fromEntries(entries);
}

export async function stateManagerToAccountInfo(
    address: Address,
    stateManager: StateManagerInterface
): Promise<AccountInfo> {
    const account = await stateManager.getAccount(address);
    assert(account !== undefined, `No account ${address.toString()}`);
    assert(stateManager.dumpStorage !== undefined, `No dump storage`);

    const storage = storageDumpToStorage(await stateManager.dumpStorage(address));
    const code = await stateManager.getCode(address);
    return {
        address,
        contract: undefined,
        deployedBytecode: code,
        storage,
        balance: account.balance,
        nonce: account.nonce
    };
}

/**
 * Adds deployment info for steps that are about to deploy a contract
 * @todo refactor this to allow multiple effects stacking in a single step.
 *       e.g. a contract containing just selfdestruct() should have 3 changed contracts (tx sender, this, selfdestruct target) and 1 deleted (this)
 */
export async function addSnapshotInfo<T extends object & LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithStateSnapshot>,
    tx: TypedTransaction
): Promise<T & WithStateSnapshot> {
    const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;

    // At the first step record the states of the current contract and the caller
    if (!lastStep) {
        return {
            ...state,
            snapshotInfo: {
                changedAccounts: [
                    await stateManagerToAccountInfo(tx.getSenderAddress(), vm.stateManager),
                    await stateManagerToAccountInfo(state.address, vm.stateManager)
                ],
                deletedAccounts: new Set()
            }
        };
    }

    /**
     * Right before a call/create/return take a snapshot of the currently executing context
     */
    if (
        state.callInfo !== undefined ||
        state.createInfo !== undefined ||
        state.returnInfo !== undefined
    ) {
        return {
            ...state,
            snapshotInfo: {
                changedAccounts: [await stateManagerToAccountInfo(state.address, vm.stateManager)],
                deletedAccounts: new Set()
            }
        };
    }

    // Right after a call or create (including calls to contracts with no code, e.g. send/transfer)
    // Take a snapshot of the caller and receiver to record the changes in balances
    if (
        lastStep &&
        (lastStep.callInfo || lastStep.createInfo) &&
        (state.depth === lastStep.depth + 1 ||
            (lastStep.callInfo && lastStep.callInfo.callToNoCodeAccount))
    ) {
        const fromAddr = lastStep.address;
        const toAddr = lastStep.callInfo
            ? lastStep.callInfo.address
            : (lastStep.createInfo as CreateInfo).address;

        return {
            ...state,
            snapshotInfo: {
                changedAccounts: [
                    await stateManagerToAccountInfo(fromAddr, vm.stateManager),
                    await stateManagerToAccountInfo(toAddr, vm.stateManager)
                ],
                deletedAccounts: new Set()
            }
        };
    }

    // Otherwise take a snapshot right before calls,creates,returns and exceptions
    if (lastStep && lastStep.op.opcode === OPCODES.SELFDESTRUCT) {
        const receiverArg = wordToAddress(lastStep.evmStack[lastStep.evmStack.length - 1]);
        return {
            ...state,
            snapshotInfo: {
                changedAccounts: [await stateManagerToAccountInfo(receiverArg, vm.stateManager)],
                deletedAccounts: new Set([lastStep.address.toString()])
            }
        };
    }

    return {
        ...state,
        snapshotInfo: undefined
    };
}
