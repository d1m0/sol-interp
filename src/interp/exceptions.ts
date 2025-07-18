import { bytesToHex } from "@ethereumjs/util";
import * as sol from "solc-typed-ast";
import { BaseScope } from "./scope";
import { Trace } from "./step";
import { printNode } from "./utils";

// Internal Errors
export class InterpError extends Error {
    constructor(public readonly node: sol.ASTNode, public readonly trace: Trace, msg: string) {
        super(`[${printNode(node)}]: ${msg}`)

    }
}

export class InternalError extends InterpError {
}

export class NoScope extends InternalError {
    constructor(node: sol.ASTNode, trace: Trace) {
        super(node, trace, `Trying to look-up identifiers with no scope`);
    }
}

export class NotDefined extends InternalError {
    constructor(node: sol.ASTNode, trace: Trace, name: string) {
        super(node, trace, `Unknown identifier ${name}`);
    }
}

export class AlreadyDefined extends InternalError {
    constructor(node: sol.ASTNode, trace: Trace, name: string, scope: BaseScope) {
        super(node, trace, `Identifier ${name} is already defined at scope ${scope.name}`);
    }
}

// Runtime Errors

export abstract class RuntimeError extends InterpError {
}

export class Revert extends RuntimeError {
    constructor(node: sol.ASTNode, trace: Trace, public readonly bytes: Uint8Array) {
        super(node, trace, `Revert with bytes ${bytesToHex(bytes)}`);
    }
}

export class OOB extends RuntimeError {
    constructor(node: sol.ASTNode, trace: Trace) {
        super(node, trace, `Out-of-bounds access`);
    }
}

export class Overflow extends RuntimeError {
    constructor(node: sol.ASTNode, trace: Trace,) {
        super(node, trace, `Overflow`);
    }
}

export class Assert extends RuntimeError {
    constructor(node: sol.ASTNode, trace: Trace, public readonly msg: string) {
        super(node, trace, `Assert fauilure`);
    }
}
