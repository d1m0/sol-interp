import { bytesToHex } from "@ethereumjs/util";
import * as sol from "solc-typed-ast"
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

export class Overflow extends InterpError {
    constructor(public readonly expr: sol.Expression) {
        super(`Overflow in ${expr.print()}`);
    }
}

export class Assert extends InterpError {
    constructor(public readonly msg: string) {
        super(`Assert fauilure: ${msg}`);
    }
}
