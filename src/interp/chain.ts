import { ContractInfo, Storage, nyi, ZERO_ADDRESS, ImmMap } from "sol-dbg";
import { CallResult, makeStateForAccount, SolMessage, WorldInterface } from "./state";
import { Interpreter } from "./interp";
import { ArtifactManager } from "./artifactManager";
import { Address, createContractAddress } from "@ethereumjs/util";
import { RuntimeError } from "./exceptions";

export interface AccountInfo {
    address: Address;
    contract: ContractInfo | undefined;
    storage: Storage;
    balance: bigint;
    nonce: bigint;
}

export abstract class EVMError extends Error {}
export class InsufficientBalance extends EVMError {}

/**
 * Simple BlockChain implementation supporting only contracts with source artifacts.
 */
export class Chain implements WorldInterface {
    state: ImmMap<string, AccountInfo>;

    constructor(public readonly artifactManager: ArtifactManager) {
        this.state = ImmMap.fromEntries([]);
    }

    create(msg: SolMessage): CallResult {
        this.expect(msg.to.equals(ZERO_ADDRESS));
        return this.execMsg(msg);
    }

    staticcall(): CallResult {
        throw new Error("Method not implemented.");
    }

    delegatecall(): CallResult {
        throw new Error("Method not implemented.");
    }

    getAccount(address: string | Address): AccountInfo | undefined {
        return this.state.get(typeof address === "string" ? address : address.toString());
    }

    // Make an externally owned account
    makeEOA(address: Address, initialBalance: bigint): void {
        // If no such account exists create a new EoA
        const newAccount: AccountInfo = {
            address,
            contract: undefined,
            storage: ImmMap.fromEntries([]),
            balance: initialBalance,
            nonce: 0n
        };

        this.setAccount(address, newAccount);
    }

    setAccount(address: string | Address, account: AccountInfo): void {
        this.state = this.state.set(
            typeof address === "string" ? address : address.toString(),
            account
        );
    }

    expect(f: boolean, msg: string = ""): asserts f {
        if (!f) {
            throw new Error(`ChainError: ${msg}`);
        }
    }

    encodeError(res: RuntimeError): Uint8Array {
        nyi(`encodeError(${res})`);
    }

    call(msg: SolMessage): CallResult {
        this.expect(!msg.to.equals(ZERO_ADDRESS));
        return this.execMsg(msg);
    }

    private getAccountForMessage(msg: SolMessage): AccountInfo {
        // Normal call
        if (!msg.to.equals(ZERO_ADDRESS)) {
            const account = this.state.get(msg.to.toString());

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

        return {
            address,
            contract,
            storage: ImmMap.fromEntries([]),
            balance: msg.value,
            nonce: 0n
        };
    }

    private execMsg(msg: SolMessage): CallResult {
        const checkpoint = this.state;
        const toAccount = this.getAccountForMessage(msg);
        const fromAccount = this.getAccount(msg.from);
        this.expect(fromAccount !== undefined, `No account for sender ${msg.from.toString()}`);

        if (msg.value > fromAccount.balance) {
            throw new InsufficientBalance();
        }

        fromAccount.balance -= msg.value;
        // @todo what about overflow here?
        toAccount.balance += msg.value;

        const contract = toAccount.contract;
        this.expect(contract !== undefined, `Not an EoA`);
        const interp = new Interpreter(this, this.artifactManager, contract.artifact);

        const interpState = makeStateForAccount(this.artifactManager, toAccount);
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
                data: this.encodeError(res)
            };
        }
    }
}
