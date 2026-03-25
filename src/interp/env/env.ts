import { Storage, ZERO_ADDRESS, ImmMap } from "sol-dbg";
import { makeStateForAccount } from "../state";
import { Interpreter } from "../interp";
import { ArtifactManager } from "../artifactManager";
import {
    Address,
    createAddressFromString,
    createContractAddress,
    createContractAddress2
} from "@ethereumjs/util";
import { InterpVisitor } from "../visitors";
import { ppAccount } from "../pp";
import { AccountInfo, CallResult, EnvInterface, AccountMap, SolMessage } from "./types";
import { Block } from "@ethereumjs/block";

export function ppChainState(state: AccountMap): string {
    const t: string[] = [];

    for (const [addr, account] of state.entries()) {
        t.push(`${addr}: ${ppAccount(account)}`);
    }

    return `{
        ${t.join(",\n")}
        }`;
}
/**
 * Simple BlockChain implementation supporting only contracts with source artifacts within a single block.
 */
export class Chain implements EnvInterface {
    state: AccountMap;
    visitors: InterpVisitor[];

    constructor(
        public readonly artifactManager: ArtifactManager,
        initialState: AccountMap = ImmMap.fromEntries([]),
        private readonly block: Block,
        private readonly maxNumSteps: undefined | number = undefined
    ) {
        this.state = initialState;
        this.visitors = [];
    }

    addVisitor(v: InterpVisitor): void {
        this.visitors.push(v);
    }

    getAccount(address: string | Address): AccountInfo | undefined {
        const key = typeof address === "string" ? address : address.toString();
        const val = this.state.get(key);

        // We create a new account here, so that any updates to the internal
        // storage field are not implicitly leaked to the state ImmMap
        return val === undefined
            ? val
            : {
                  address: val.address,
                  contract: val.contract,
                  deployedBytecode: val.deployedBytecode,
                  storage: val.storage,
                  balance: val.balance,
                  nonce: val.nonce
              };
    }

    getOrMakeAccount(address: string | Address): AccountInfo {
        const acc = this.getAccount(address);
        if (acc !== undefined) {
            return acc;
        }

        return {
            address: address instanceof Address ? address : createAddressFromString(address),
            contract: undefined,
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]),
            balance: 0n,
            nonce: 0n
        };
    }

    setAccount(address: string | Address, account: AccountInfo): void {
        this.state = this.state.set(typeof address === "string" ? address : address.toString(), {
            address: account.address,
            contract: account.contract,
            deployedBytecode: account.deployedBytecode,
            storage: account.storage,
            balance: account.balance,
            nonce: account.nonce
        });
    }

    updateAccount(account: AccountInfo): void {
        this.setAccount(account.address, account);
    }

    // Make an externally owned account
    makeEmptyAccount(address: Address, initialBalance: bigint): void {
        // If no such account exists create a new EoA
        const newAccount: AccountInfo = {
            address,
            contract: undefined,
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]),
            balance: initialBalance,
            nonce: 0n
        };

        this.setAccount(address, newAccount);
    }

    expect(f: boolean, msg: string = ""): asserts f {
        if (!f) {
            throw new Error(`ChainError: ${msg}`);
        }
    }

    private getAccountForMessage(msg: SolMessage): AccountInfo {
        // Normal call
        if (!msg.to.equals(ZERO_ADDRESS)) {
            let account = this.getAccount(msg.to);

            if (account === undefined) {
                this.makeEmptyAccount(msg.to, 0n);
                account = this.getAccount(msg.to) as AccountInfo;
            }

            return account;
        }

        // Contract creation - initialize a new empty account
        const sender = this.getAccount(msg.from);
        this.expect(sender !== undefined);

        let newAddress;
        if (msg.salt === undefined) {
            newAddress = createContractAddress(sender.address, sender.nonce - 1n);
        } else {
            newAddress = createContractAddress2(sender.address, msg.salt, msg.data);
        }

        const contract = this.artifactManager.getContractFromCreationBytecode(msg.data);
        this.expect(contract !== undefined);

        const res = {
            address: newAddress,
            contract,
            bytecode: msg.data,
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]) as Storage,
            balance: 0n,
            nonce: 1n, // Since EIP-161 the nonce is increased by 1 before init code runs
            gen: 0n
        };

        this.setAccount(newAddress, res);

        return { ...res };
    }

    execMsg(msg: SolMessage): CallResult {
        const checkpoint = this.state;
        const fromAccount = this.getAccount(msg.from);
        this.expect(fromAccount !== undefined, `No account for sender ${msg.from.toString()}`);
        const delegatingAccount: AccountInfo | undefined =
            msg.delegatingContract === undefined
                ? undefined
                : this.getAccount(msg.delegatingContract);

        const valueSendingAccount =
            delegatingAccount !== undefined ? delegatingAccount : fromAccount;

        // Increment sender nonce
        if (msg.depth === 0) {
            valueSendingAccount.nonce++;
            this.updateAccount(valueSendingAccount);
        }

        const toAccount = this.getAccountForMessage(msg);
        const contract = toAccount.contract;

        const valueReceivingAccount =
            delegatingAccount !== undefined ? delegatingAccount : toAccount;

        if (msg.value > valueSendingAccount.balance) {
            this.state = checkpoint;
            return { reverted: true, data: new Uint8Array() };
        }

        valueSendingAccount.balance -= msg.value;
        // @todo what about overflow here?
        valueReceivingAccount.balance += msg.value;

        this.updateAccount(valueSendingAccount);
        if (valueReceivingAccount !== valueSendingAccount) {
            this.updateAccount(valueReceivingAccount);
        }

        // Calls to contracts with no code succeed.
        if (contract === undefined) {
            return {
                reverted: false,
                data: new Uint8Array()
            };
        }

        const interp = new Interpreter(
            this,
            this.artifactManager,
            contract.artifact,
            this.visitors
        );

        if (this.maxNumSteps !== undefined) {
            interp.setMaxNumSteps(this.maxNumSteps);
        }

        const interpState = makeStateForAccount(
            this.artifactManager,
            delegatingAccount ? delegatingAccount : toAccount,
            delegatingAccount ? toAccount : undefined,
            msg.isStaticCall
        );

        interpState.block = this.block;

        const isCall = !msg.to.equals(ZERO_ADDRESS);
        const res = isCall ? interp.call(msg, interpState) : interp.create(msg, interpState);

        if (res instanceof Uint8Array) {
            const callRes: CallResult = {
                reverted: false,
                data: res
            };

            if (!isCall) {
                callRes.newContract = toAccount.address;
            }

            return callRes;
        } else {
            // Call failed - revert state
            this.state = checkpoint;

            return {
                reverted: true,
                data: res.payload
            };
        }
    }
}
