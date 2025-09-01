import { ContractInfo, Storage, nyi, ZERO_ADDRESS, ImmMap } from "sol-dbg";
import { CallResult, makeStateForAccount, SolMessage, WorldInterface } from "./state";
import { Interpreter } from "./interp";
import { ArtifactManager } from "./artifactManager";
import { Address } from "@ethereumjs/util";
import { RuntimeError } from "./exceptions";

export interface AccountInfo {
    address: Address;
    contract: ContractInfo;
    storage: Storage;
    balance: bigint;
    nonce: bigint;
}

export class Chain implements WorldInterface {
    state: ImmMap<string, AccountInfo>;

    constructor(public readonly artifactManager: ArtifactManager) {
        this.state = ImmMap.fromEntries([]);
    }

    create(): CallResult {
        throw new Error("Method not implemented.");
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
        const checkpoint = this.state;

        this.expect(!msg.to.equals(ZERO_ADDRESS));
        const account = this.state.get(msg.to.toString());

        if (account === undefined) {
            nyi(`calling a missing account`);
        }

        const interp = new Interpreter(this, this.artifactManager, account.contract.artifact);

        const interpState = makeStateForAccount(this.artifactManager, account);
        const res = interp.call(msg, interpState);

        if (res instanceof Uint8Array) {
            return {
                reverted: false,
                data: res
            };
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
