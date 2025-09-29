import { concatBytes, hexToBytes } from "@ethereumjs/util";
import * as sol from "solc-typed-ast";
import { BaseScope } from "./scope";
import { Trace } from "./step";
import { printNode } from "./utils";
import { BuiltinFunction } from "./value";
import { makeMemoryView, uint256 } from "sol-dbg";
import * as ethABI from "web3-eth-abi";

type FailLoc = sol.ASTNode | BuiltinFunction;
// Internal Errors
export class InterpError extends Error {
    constructor(
        public readonly node: FailLoc,
        public readonly trace: Trace,
        msg: string
    ) {
        const loc = node instanceof BuiltinFunction ? node.pp() : printNode(node);
        super(`[${loc}]: ${msg}`);
    }
}

/**
 * Base class for all exceptions that are internal. I.e. - they are due to an
 * issue with the interpreter, not the interpreted code.
 */
export class InternalError extends InterpError {}

export class NoScope extends InternalError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, `Trying to look-up identifiers with no scope`);
    }
}

export class NotDefined extends InternalError {
    constructor(node: FailLoc, trace: Trace, name: string) {
        super(node, trace, `Unknown identifier ${name}`);
    }
}

export class AlreadyDefined extends InternalError {
    constructor(node: FailLoc, trace: Trace, name: string, scope: BaseScope) {
        super(node, trace, `Identifier ${name} is already defined at scope ${scope.name}`);
    }
}

// Runtime Errors

/**
 * Base class for all normal EVM runtime exceptions. These come from the interpreted code.
 */
export class RuntimeError extends InterpError {
    constructor(
        public readonly node: FailLoc,
        public readonly trace: Trace,
        public readonly msg: string,
        public readonly payload: Uint8Array
    ) {
        super(node, trace, msg);
    }
}

const PANIC_SCRATCH = concatBytes(hexToBytes("0x4e487b71"), new Uint8Array(32));
// Using memory instead of calldata view here since it allows encoding and for uint256 its the same.
const PANIC_VIEW = makeMemoryView(uint256, 4n);

export class PanicError extends RuntimeError {
    constructor(
        node: FailLoc,
        trace: Trace,
        public readonly code: bigint
    ) {
        PANIC_VIEW.encode(code, PANIC_SCRATCH, null as unknown as any);
        super(node, trace, `Panic(${code})`, new Uint8Array(PANIC_SCRATCH));
    }
}

// Panic(uint256) errors
export class AssertError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x01n);
    }
}

export class OverflowError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x11n);
    }
}

export class DivBy0Error extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x12n);
    }
}

export class EnumCastError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x21n);
    }
}

export class StorageByteArrayEncodingError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x22n);
    }
}

export class EmptyArrayPopError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x31n);
    }
}

export class OOBError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x32n);
    }
}

export class TooMuchMemError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x41n);
    }
}

export class UninitializedFunPtrError extends PanicError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, 0x51n);
    }
}

const ERROR_SELECTOR = "0x08c379a0";
/**
 * Error(string) errors.
 */
export class ErrorError extends RuntimeError {
    constructor(
        node: FailLoc,
        trace: Trace,
        public readonly msg: string
    ) {
        const payload = hexToBytes(
            ethABI.encodeParameters(["bytes4", "string"], [ERROR_SELECTOR, msg]) as `0x${string}`
        );
        super(node, trace, `Error(${msg})`, payload);
    }
}

/**
 * An error with no payload. (e.g. require(bool), revert())
 */
export class NoPayloadError extends RuntimeError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace, ``, new Uint8Array());
    }
}

export class InsufficientBalance extends NoPayloadError {
    constructor(node: FailLoc, trace: Trace) {
        super(node, trace);
    }
}
