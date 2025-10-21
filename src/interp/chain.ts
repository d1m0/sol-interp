import { ContractInfo, Storage, nyi, ZERO_ADDRESS, ImmMap } from "sol-dbg";
import { CallResult, makeStateForAccount, SolMessage, WorldInterface } from "./state";
import { Interpreter } from "./interp";
import { ArtifactManager } from "./artifactManager";
import { Address, createContractAddress } from "@ethereumjs/util";
import { InterpVisitor } from "./visitors";
import { ppAccount } from "./pp";

export interface AccountInfo {
    address: Address;
    contract: ContractInfo | undefined;
    // Creation bytecode. May differ from the artifact bytecode by link references
    bytecode: Uint8Array;
    // Deployed bytecode. May differ from the artifact deployed bytecode by link and immtable references
    deployedBytecode: Uint8Array;
    storage: Storage;
    balance: bigint;
    nonce: bigint;
}

export function ppChainState(state: ImmMap<string, AccountInfo>): string {
    const t: string[] = [];

    for (const [addr, account] of state.entries()) {
        t.push(`${addr}: ${ppAccount(account)}`);
    }

    return `{
        ${t.join(",\n")}
        }`;
}
/**
 * Simple BlockChain implementation supporting only contracts with source artifacts.
 */
export class Chain implements WorldInterface {
    state: ImmMap<string, AccountInfo>;
    visitors: InterpVisitor[];

    constructor(public readonly artifactManager: ArtifactManager) {
        this.state = ImmMap.fromEntries([]);
        this.visitors = [];
    }

    addVisitor(v: InterpVisitor): void {
        this.visitors.push(v);
    }

    create(msg: SolMessage): CallResult {
        this.expect(msg.to.equals(ZERO_ADDRESS));
        this.expect(msg.delegatingContract === undefined);
        return this.execMsg(msg);
    }

    staticcall(): CallResult {
        throw new Error("Method not implemented.");
    }

    delegatecall(msg: SolMessage): CallResult {
        this.expect(!msg.to.equals(ZERO_ADDRESS));
        this.expect(msg.delegatingContract !== undefined);
        return this.execMsg(msg);
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
                  bytecode: val.bytecode,
                  deployedBytecode: val.deployedBytecode,
                  storage: val.storage,
                  balance: val.balance,
                  nonce: val.nonce
              };
    }

    setAccount(address: string | Address, account: AccountInfo): void {
        this.state = this.state.set(typeof address === "string" ? address : address.toString(), {
            address: account.address,
            contract: account.contract,
            bytecode: account.bytecode,
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
    makeEOA(address: Address, initialBalance: bigint): void {
        // If no such account exists create a new EoA
        const newAccount: AccountInfo = {
            address,
            contract: undefined,
            bytecode: new Uint8Array(),
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

    call(msg: SolMessage): CallResult {
        this.expect(!msg.to.equals(ZERO_ADDRESS));
        this.expect(msg.delegatingContract === undefined);
        return this.execMsg(msg);
    }

    private getAccountForMessage(msg: SolMessage): AccountInfo {
        // Normal call
        if (!msg.to.equals(ZERO_ADDRESS)) {
            const account = this.getAccount(msg.to);

            if (account === undefined) {
                nyi(`calling a missing account`);
            }

            return account;
        }

        // Contract creation - initialize a new empty account
        const sender = this.getAccount(msg.from);
        this.expect(sender !== undefined);

        const address = createContractAddress(sender.address, sender.nonce);
        const contract = this.artifactManager.getContractFromCreationBytecode(msg.data);
        this.expect(contract !== undefined);

        const res = {
            address,
            contract,
            bytecode: msg.data,
            deployedBytecode: new Uint8Array(),
            storage: ImmMap.fromEntries([]) as Storage,
            balance: 0n,
            nonce: 0n,
            gen: 0n
        };

        this.setAccount(address, res);

        return { ...res };
    }

    private execMsg(msg: SolMessage): CallResult {
        const checkpoint = this.state;
        const fromAccount = this.getAccount(msg.from);
        this.expect(fromAccount !== undefined, `No account for sender ${msg.from.toString()}`);
        const delegatingAccount: AccountInfo | undefined =
            msg.delegatingContract === undefined
                ? undefined
                : this.getAccount(msg.delegatingContract);
        const toAccount = this.getAccountForMessage(msg);

        const contract = toAccount.contract;
        this.expect(contract !== undefined, `Not an EoA`);

        const valueSendingAccount =
            delegatingAccount !== undefined ? delegatingAccount : fromAccount;
        const valueReceivingAccount =
            delegatingAccount !== undefined ? delegatingAccount : toAccount;

        if (msg.value > valueSendingAccount.balance) {
            return { reverted: true, data: new Uint8Array() };
        }

        // Increment sender nonce
        valueSendingAccount.nonce++;
        valueSendingAccount.balance -= msg.value;
        // @todo what about overflow here?
        valueReceivingAccount.balance += msg.value;

        this.updateAccount(valueSendingAccount);
        if (valueReceivingAccount !== valueSendingAccount) {
            this.updateAccount(valueReceivingAccount);
        }

        const interp = new Interpreter(
            this,
            this.artifactManager,
            contract.artifact,
            this.visitors
        );

        const interpState = makeStateForAccount(
            this.artifactManager,
            delegatingAccount ? delegatingAccount : toAccount,
            delegatingAccount ? toAccount : undefined
        );
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
