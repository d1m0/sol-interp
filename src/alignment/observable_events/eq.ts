import {
    EVMCallEvent,
    EVMCreateEvent,
    EVMEmitEvent,
    EVMExceptionEvent,
    EVMObservableEvent,
    EVMReturnEvent
} from "./evm_events";
import {
    SolCallEvent,
    SolCreateEvent,
    SolEmitEvent,
    SolExceptionEvent,
    SolObservableEvent,
    SolReturnEvent
} from "./sol_events";
import { assert } from "../../utils";
import { ZERO_ADDRESS, Storage, EventDesc } from "sol-dbg";
import { bytesToHex, equalsBytes } from "@ethereumjs/util";
import { EVMStep } from "../evm_trace";
import { AccountInfo } from "../../interp";

/**
 * In some cases the LL-data includes some 0-es at the end.
 * Seems to happen when passing empty bytes arrays. So we do fuzzy matching here
 * @todo Investigate why that difference occur
 */
function msgDataEq(hlData: Uint8Array, llData: Uint8Array): boolean {
    if (hlData.length > llData.length) {
        return false;
    }

    for (let i = 0; i < hlData.length; i++) {
        if (hlData[i] !== llData[i]) {
            return false;
        }
    }

    for (let i = hlData.length; i < llData.length; i++) {
        if (llData[i] !== 0) {
            return false;
        }
    }

    return true;
}

function isAllZeroes(b: Uint8Array): boolean {
    for (let i = 0; i < b.length; i++) {
        if (b[i] !== 0) {
            return false;
        }
    }

    return true;
}

function removeZeroValues(m: Map<bigint, Uint8Array>): void {
    for (const [k, v] of m.entries()) {
        if (isAllZeroes(v)) {
            m.delete(k);
        }
    }
}

function storageEq(llStorage: Storage, hlStorage: Storage): boolean {
    const llMap = llStorage.collectMap();
    const hlMap = hlStorage.collectMap();

    removeZeroValues(hlMap);

    if (llMap.size !== hlMap.size) {
        return false;
    }

    for (const [key, val] of llMap) {
        const hlVal = hlMap.get(key);
        if (hlVal === undefined || !equalsBytes(val, hlVal)) {
            console.error(
                `Diff in key ${key} ll: ${bytesToHex(val)} ${hlVal === undefined ? hlVal : bytesToHex(hlVal)}`
            );
            return false;
        }
    }

    return true;
}

function accountsEq(llAccountInfo: AccountInfo, hlAccountInfo: AccountInfo): boolean {
    return (
        llAccountInfo.balance === hlAccountInfo.balance &&
        //        llAccountInfo.nonce === hlAccountInfo.nonce &&
        storageEq(llAccountInfo.storage, hlAccountInfo.storage)
    );
}

function eventsEq(llEvent: EventDesc, hlEvent: EventDesc): boolean {
    if (llEvent.topics.length !== hlEvent.topics.length) {
        return false;
    }

    for (let i = 0; i < llEvent.topics.length; i++) {
        if (!equalsBytes(llEvent.topics[i], hlEvent.topics[i])) {
            return false;
        }
    }

    return equalsBytes(llEvent.payload, hlEvent.payload);
}

/**
 * Check whether a given low-level observable event and a high-level observable event match
 * @param llEvent
 * @param hlEvent
 * @returns
 */
export function eventsMatch(
    llEvent: EVMObservableEvent,
    llStep: EVMStep,
    hlEvent: SolObservableEvent,
    hlAccount: AccountInfo
): boolean {
    if (llEvent instanceof EVMCallEvent && hlEvent instanceof SolCallEvent) {
        const llData = llEvent.data;
        const hlData = hlEvent.data;

        const hlAddress = hlData.delegatingContract ? hlData.delegatingContract : hlData.to;
        const hlCodeAddress = hlData.to;

        assert(
            llStep.snapshotInfo !== undefined && llStep.snapshotInfo.changedAccounts.length === 1,
            ``
        );
        const llAccountInfo = llStep.snapshotInfo.changedAccounts[0];

        assert(llAccountInfo !== undefined, ``);

        return (
            llData.address.equals(hlAddress) &&
            llData.codeAddress.equals(hlCodeAddress) &&
            msgDataEq(hlData.data, llData.msgData) &&
            llData.value === hlData.value &&
            accountsEq(llAccountInfo, hlAccount)
        );
    }

    if (llEvent instanceof EVMCreateEvent && hlEvent instanceof SolCreateEvent) {
        const llData = llEvent.data;
        const hlData = hlEvent.data;

        assert(hlData.to.equals(ZERO_ADDRESS), ``);

        if (llData.salt === undefined || hlData.salt === undefined) {
            if (llData.salt !== undefined || hlData.salt !== undefined) {
                return false;
            }
        } else {
            if (!equalsBytes(llData.salt, hlData.salt)) {
                return false;
            }
        }

        assert(
            llStep.snapshotInfo !== undefined && llStep.snapshotInfo.changedAccounts.length === 1,
            ``
        );
        const llAccountInfo = llStep.snapshotInfo.changedAccounts[0];

        assert(llAccountInfo !== undefined, ``);

        return (
            msgDataEq(hlData.data, llData.msgData) &&
            llData.value === hlData.value &&
            accountsEq(llAccountInfo, hlAccount)
        );
    }

    if (llEvent instanceof EVMReturnEvent && hlEvent instanceof SolReturnEvent) {
        const llData = llEvent.data;
        const hlData = hlEvent.data;

        assert(
            llStep.snapshotInfo !== undefined && llStep.snapshotInfo.changedAccounts.length === 1,
            ``
        );
        const llAccountInfo = llStep.snapshotInfo.changedAccounts[0];

        assert(llAccountInfo !== undefined, ``);

        return (
            equalsBytes(llData.retData, hlData.data) &&
            ((llData.newContract !== undefined &&
                hlData.newContract !== undefined &&
                llData.newContract.equals(hlData.newContract)) ||
                (llData.newContract == undefined && hlData.newContract == undefined)) &&
            accountsEq(llAccountInfo, hlAccount)
        );
    }

    if (llEvent instanceof EVMExceptionEvent && hlEvent instanceof SolExceptionEvent) {
        return msgDataEq(hlEvent.data, llEvent.data.excData);
    }

    if (llEvent instanceof EVMEmitEvent && hlEvent instanceof SolEmitEvent) {
        return eventsEq(llEvent.data, hlEvent.data.evmEvent);
    }

    return false;
}
