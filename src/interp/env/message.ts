import { TypedTransaction } from "@ethereumjs/tx";
import { Address, createContractAddress, createContractAddress2 } from "@ethereumjs/util";
import { ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";

export enum SolMessageType {
    CREATE = 1,
    CALLCODE,
    DELEGATECALL,
    STATICCALL,
    CALL
}

export class SolMessage {
    private constructor(
        public readonly type: SolMessageType,
        // Target address
        // - for CREATE - ZERO_ADDRESS
        // - for DELEGATECALL/CALLCODE - the address of the code account we are calling
        // - for other cases - the address of the account we are calling
        public readonly to: Address,
        // Address of the account from which the call originates. Note that for
        // DELEGATECALL/CALLCODE its the address of the actual account,not the
        // code account
        public readonly originatingContextAddress: Address,
        // msg.sender. For `DELEGATECALL` this differs from `_originatingContextAddress`
        public readonly sender: Address,
        public readonly value: bigint,
        public readonly gas: bigint | undefined,
        public readonly salt: Uint8Array | undefined,
        public readonly data: Uint8Array,
        public readonly depth: number,
        private readonly nonce: bigint | undefined,
        private readonly _parent: SolMessage | TypedTransaction
    ) {}

    isCreation(): boolean {
        return this.type === SolMessageType.CREATE;
    }

    delegatingContract(): Address | undefined {
        if (this.type !== SolMessageType.DELEGATECALL && this.type !== SolMessageType.CALLCODE) {
            return undefined;
        }

        return this.originatingContextAddress;
    }

    /**
     * Only valid for Create messages. (throws exception otherwise)
     * The address of the newly created contract by the create message
     */
    newContractAddress(): Address {
        sol.assert(
            this.type === SolMessageType.CREATE,
            `newContractAddress only valid for CREATE messages`
        );
        sol.assert(this.nonce !== undefined, `nonce must be specified for new contracts`);

        if (this.salt === undefined) {
            return createContractAddress(this.originatingContextAddress, BigInt(this.nonce));
        } else {
            return createContractAddress2(this.originatingContextAddress, this.salt, this.data);
        }
    }

    executingContextAddress(): Address {
        if (this.type === SolMessageType.CREATE) {
            return this.newContractAddress();
        }

        if (this.type === SolMessageType.DELEGATECALL || this.type === SolMessageType.CALLCODE) {
            sol.assert(
                this._parent instanceof SolMessage,
                `Root message of a TX cannot be a delegate call.`
            );
            return this._parent.executingContextAddress();
        }

        return this.to;
    }

    static fromTx(t: TypedTransaction): SolMessage {
        const isCreation = t.to === undefined || t.to.equals(ZERO_ADDRESS);
        const sender = t.getSenderAddress();

        return new SolMessage(
            isCreation ? SolMessageType.CREATE : SolMessageType.CALL,
            t.to === undefined ? ZERO_ADDRESS : t.to,
            sender,
            sender,
            t.value,
            t.gasLimit,
            undefined,
            t.data,
            0,
            isCreation ? t.nonce : undefined,
            t
        );
    }

    /**
     * Create a dummy message to be used in the constant eval context
     */
    static constantEvalMessage(): SolMessage {
        return new SolMessage(
            SolMessageType.CALL,
            ZERO_ADDRESS,
            ZERO_ADDRESS,
            ZERO_ADDRESS,
            0n,
            0n,
            undefined,
            new Uint8Array(),
            0,
            undefined,
            undefined as unknown as any
        );
    }

    /**
     * Mock up a `SolMessage` for testing.
     */
    static testMessage(
        type: SolMessageType,
        from: Address,
        to: Address,
        data: Uint8Array,
        gas: bigint,
        value: bigint,
        nonce: bigint | undefined
    ): SolMessage {
        return new SolMessage(
            type,
            to,
            from,
            from,
            value,
            gas,
            undefined,
            data,
            0,
            nonce,
            undefined as unknown as any
        );
    }

    /**
     * Build a new `SolMessage` due to a `CREATE` instruction in the execution context of the current `SolMessage`.
     */
    create(
        value: bigint,
        salt: Uint8Array | undefined,
        msgData: Uint8Array,
        nonce: bigint
    ): SolMessage {
        return new SolMessage(
            SolMessageType.CREATE,
            ZERO_ADDRESS,
            this.executingContextAddress(),
            this.executingContextAddress(),
            value,
            undefined,
            salt,
            msgData,
            this.depth + 1,
            nonce,
            this
        );
    }

    /**
     * Build a new `SolMessage` due to a `CALLCODE` instruction in the execution context of the current `SolMessage`.
     */
    callcode(gas: bigint, to: Address, value: bigint, msgData: Uint8Array): SolMessage {
        return new SolMessage(
            SolMessageType.CALLCODE,
            to,
            this.executingContextAddress(),
            // CALLCODE doesn't preserve msg.sender
            this.executingContextAddress(),
            // CALLCODE doesn't forward all the value
            value,
            gas,
            undefined,
            msgData,
            this.depth + 1,
            undefined,
            this
        );
    }

    /**
     * Build a new `SolMessage` due to a `DELEGATECALL` instruction in the execution context of the current `SolMessage`.
     */
    delegatecall(gas: bigint, to: Address, msgData: Uint8Array): SolMessage {
        return new SolMessage(
            SolMessageType.DELEGATECALL,
            to,
            this.executingContextAddress(),
            // DELEGATECALL preserves msg.sender
            this.sender,
            // DELEGATECALL forwards all the value
            this.value,
            gas,
            undefined,
            msgData,
            this.depth + 1,
            undefined,
            this
        );
    }

    /**
     * Build a new `SolMessage` due to a `STATICCALL` instruction in the execution context of the current `SolMessage`.
     */
    staticcall(gas: bigint, to: Address, msgData: Uint8Array): SolMessage {
        return new SolMessage(
            SolMessageType.STATICCALL,
            to,
            this.executingContextAddress(),
            this.executingContextAddress(),
            // STATICCALL may not forward Eth
            0n,
            gas,
            undefined,
            msgData,
            this.depth + 1,
            undefined,
            this
        );
    }

    /**
     * Build a new `SolMessage` due to a `CALL` instruction in the execution context of the current `SolMessage`.
     */
    call(gas: bigint, to: Address, value: bigint, msgData: Uint8Array): SolMessage {
        return new SolMessage(
            SolMessageType.CALL,
            to,
            this.executingContextAddress(),
            this.executingContextAddress(),
            value,
            gas,
            undefined,
            msgData,
            this.depth + 1,
            undefined,
            this
        );
    }
}
