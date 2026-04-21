import { keccak256 } from "ethereum-cryptography/keccak";
import { bigEndianBufToBigint, bigIntToBuf, ImmMap, Storage } from "sol-dbg";
import { EVMStep } from "../alignment/evm_trace";
import { AccountMap } from "../interp";

function terminate(message?: string, exitCode = 0): never {
    if (message !== undefined) {
        if (exitCode === 0) {
            console.log(message);
        } else {
            console.error(message);
        }
    }

    process.exit(exitCode);
}

export function error(message: string): never {
    terminate(message, 1);
}

/**
 * Return set of addresses that were executed during the trace. In the case of
 * delegate calls this includes both the delegated and delegating contracts.
 */
export function getExecutedAddresses(trace: EVMStep[]): Set<string> {
    const addrsTouched = new Set<string>();
    for (const step of trace) {
        addrsTouched.add(step.address.toString());
        if (step.codeAddress !== undefined) {
            addrsTouched.add(step.codeAddress.toString());
        }
    }
    return addrsTouched;
}

function lowerStorage(s: Storage): Storage {
    return ImmMap.fromEntries(
        [...s.entries()].map(([key, val]) => [
            bigEndianBufToBigint(keccak256(bigIntToBuf(key, 32, "big"))),
            val
        ])
    );
}

export function tracerStorageToStorageDump(tStorage: AccountMap): AccountMap {
    return ImmMap.fromEntries(
        [...tStorage.entries()].map(([addr, accInfo]) => [
            addr,
            {
                ...accInfo,
                storage: lowerStorage(accInfo.storage)
            }
        ])
    );
}
