/**
 * Solidity trace-level observable events
 */

import { EventDesc } from "sol-dbg";
import { CallResult, SolMessage } from "../../interp";

type SolPayloadTypes = SolMessage | CallResult | Uint8Array | SolEventDesc | bigint;

class SolEvent<T extends SolPayloadTypes> {
    constructor(public readonly data: T) {}
}

export interface SolEventDesc {
    evmEvent: EventDesc;
    signature: string;
    hash: `0x${string}`;
}

export class SolCallEvent extends SolEvent<SolMessage> {}
export class SolCreateEvent extends SolEvent<SolMessage> {}
export class SolReturnEvent extends SolEvent<CallResult> {}
export class SolExceptionEvent extends SolEvent<Uint8Array> {}
export class SolEmitEvent extends SolEvent<SolEventDesc> {}
export class SolGasLeftEvent extends SolEvent<bigint> {}

export type SolObservableEvent =
    | SolCallEvent
    | SolCreateEvent
    | SolReturnEvent
    | SolExceptionEvent
    | SolEmitEvent
    | SolGasLeftEvent;
