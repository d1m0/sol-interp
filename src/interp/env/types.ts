import { Block } from "@ethereumjs/block";
import { Address } from "@ethereumjs/util";
import * as rtt from "sol-dbg";
import { SolMessage } from "./message";

export interface AccountInfo {
    address: Address;
    contract: rtt.ContractInfo | undefined;
    // Deployed bytecode. May differ from the artifact deployed bytecode by link and immtable references
    deployedBytecode: Uint8Array;
    storage: rtt.Storage;
    balance: bigint;
    nonce: bigint;
}

export type AccountMap = rtt.ImmMap<string, AccountInfo>;

export interface CallResult {
    reverted: boolean;
    data: Uint8Array;
    newContract?: Address;
}

export interface EthereumEnvInterface {
    execMsg(msg: SolMessage): CallResult;
    getAccount(address: string | Address): AccountInfo | undefined;
    setAccount(address: string | Address, account: AccountInfo): void;
    updateAccount(account: AccountInfo): void;
    getBlock(number: bigint): Block | undefined;
    gasleft(): bigint;
}
