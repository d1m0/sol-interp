/**
 * Solidity trace-level observable events
 */

import { EventDesc } from "sol-dbg";
import { CallResult, SolMessage } from "../../interp";

type SolPayloadTypes = SolMessage | CallResult | Uint8Array | EventDesc | bigint;

class SolEvent<T extends SolPayloadTypes> {
    constructor(public readonly data: T) {}
}

export class SolCallEvent extends SolEvent<SolMessage> {}
export class SolCreateEvent extends SolEvent<SolMessage> {}
export class SolReturnEvent extends SolEvent<CallResult> {}
export class SolExceptionEvent extends SolEvent<Uint8Array> {}
export class SolEmitEvent extends SolEvent<EventDesc> {}
export class SolGasLeftEvent extends SolEvent<bigint> {}

export type SolObservableEvent =
    | SolCallEvent
    | SolCreateEvent
    | SolReturnEvent
    | SolExceptionEvent
    | SolEmitEvent
    | SolGasLeftEvent;
