import { StorageDump } from "@ethereumjs/common";
import { Address, hexToBigInt, setLengthLeft } from "@ethereumjs/util";
import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, Storage, OpInfo, ImmMap } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";
import { assert } from "../../../utils";
import { WithCreateInfo } from "./create";
import { WithCallInfo } from "./call";
import { WithExceptionInfo } from "./exceptions";
import { WithReturnInfo } from "./return";
import { AccountInfo } from "../../../interp";
import { RLP } from "@ethereumjs/rlp";

export interface WithStateSnapshot {
    snapshot: AccountInfo | undefined;
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

async function snapshotContractState(
    address: Address,
    state: LowerStep,
    vm: VM
): Promise<AccountInfo> {
    const account = await vm.stateManager.getAccount(address);
    assert(account !== undefined, `No account ${address.toString()}`);
    assert(vm.stateManager.dumpStorage !== undefined, `No dump storage`);

    const storage = storageDumpToStorage(await vm.stateManager.dumpStorage(address));
    const code = await vm.stateManager.getCode(address);
    return {
        address,
        contract: undefined,
        bytecode: new Uint8Array(), // @todo delete
        deployedBytecode: code,
        storage,
        balance: account.balance,
        nonce: account.nonce
    };
}

/**
 * Adds deployment info for steps that are about to deploy a contract
 */
export async function addSnapshotInfo<T extends object & LowerStep>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: Array<T & WithStateSnapshot>
): Promise<T & WithStateSnapshot> {
    const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;

    // Take a snapshot of the caller context after a failed call
    if (lastStep && lastStep.exceptionInfo !== undefined) {
        return {
            ...state,
            snapshot: await snapshotContractState(state.address, state, vm)
        };
    }

    // Otherwise take a snapshot right before calls,creates,returns and exceptions
    if (
        state.callInfo === undefined &&
        state.createInfo === undefined &&
        state.returnInfo === undefined
    ) {
        return { ...state, snapshot: undefined };
    }

    return {
        ...state,
        snapshot: await snapshotContractState(state.address, state, vm)
    };
}
