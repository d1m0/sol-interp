import { bytesToHex } from "@ethereumjs/util";
import { BaseScope } from "./scope";

export class InterpError extends Error {}

export class NoScope extends InterpError {
    constructor() {
        super(`Trying to look-up identifiers with no scope`);
    }
}

export class NotDefined extends InterpError {
    constructor(name: string) {
        super(`Unknown identifier ${name}`);
    }
}

export class AlreadyDefined extends InterpError {
    constructor(name: string, scope: BaseScope) {
        super(`Identifier ${name} is already defined at scope ${scope.name}`);
    }
}

export class Revert extends InterpError {
    constructor(public readonly bytes: Uint8Array) {
        super(`Revert with bytes ${bytesToHex(bytes)}`);
    }
}
