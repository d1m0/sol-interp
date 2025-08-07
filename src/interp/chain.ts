import { ContractInfo, Storage, nyi, ZERO_ADDRESS } from "sol-dbg";
import { CallResult, makeStateWithConstants, SolMessage, WorldInterface } from "./state";
import { Interpreter } from "./interp";
import { ArtifactManager } from "./artifactManager";
import { Address } from "@ethereumjs/util";
import { RuntimeError } from "./exceptions";

export interface AccountInfo {
    contract: ContractInfo;
    storage: Storage;
    balance: bigint;
    nonce: bigint;
}

export interface ChainState {
    accounts: Map<string, AccountInfo>;
}

export class Chain implements ChainState {
    accounts: Map<string, AccountInfo> = new Map();

    constructor(public readonly artifactManager: ArtifactManager) {}

    getAccount(address: string | Address): AccountInfo | undefined {
        return this.accounts.get(typeof address === "string" ? address : address.toString());
    }

    setAccount(address: string | Address, account: AccountInfo): void {
        this.accounts.set(typeof address === "string" ? address : address.toString(), account);
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
        const account = this.accounts.get(msg.to.toString());

        if (account === undefined) {
            nyi(`calling a missing account`);
        }

        const worldInterface: WorldInterface = {
            create: function (): Promise<CallResult> {
                nyi("Function not implemented.");
            },
            call: function (): Promise<CallResult> {
                nyi("Function not implemented.");
            },
            staticcall: function (): Promise<CallResult> {
                nyi("Function not implemented.");
            },
            delegatecall: function (): Promise<CallResult> {
                nyi("Function not implemented.");
            },
            getStorage: function (): Storage {
                nyi("Function not implemented.");
            }
        };

        const interp = new Interpreter(
            worldInterface,
            this.artifactManager,
            account.contract.artifact
        );

        const state = makeStateWithConstants(this.artifactManager, account.contract.artifact);
        state.contract = account.contract;
        state.mdc = account.contract.ast;
        const res = interp.call(msg, state);

        if (res instanceof Uint8Array) {
            return {
                reverted: false,
                data: res
            };
        } else {
            return {
                reverted: true,
                data: this.encodeError(res)
            };
        }
    }
}
