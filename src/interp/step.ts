import * as sol from "solc-typed-ast";
import { LValue, Value } from "./value";
import { RuntimeError } from "./exceptions";
import { EventDesc } from "sol-dbg";
import { CallResult, SolMessage } from "./env";
import { StateSnapshot } from "./state";

export abstract class BaseStep {
    constructor(public readonly state?: StateSnapshot) {}
}

export type Trace = BaseStep[];

export class EvalStep extends BaseStep {
    constructor(
        public readonly expr: sol.Expression,
        public readonly val: Value | LValue,
        state?: StateSnapshot
    ) {
        super(state);
    }
}

export class ExecStep extends BaseStep {
    constructor(
        public readonly stmt: sol.Statement,
        state?: StateSnapshot
    ) {
        super(state);
    }
}

export class ExtCallStep extends BaseStep {
    constructor(
        public readonly msg: SolMessage,
        state?: StateSnapshot
    ) {
        super(state);
    }
}

export class ExtReturnStep extends BaseStep {
    constructor(
        public readonly res: CallResult,
        state?: StateSnapshot
    ) {
        super(state);
    }
}

export class ExceptionStep extends BaseStep {
    constructor(
        public readonly exception: RuntimeError,
        state?: StateSnapshot
    ) {
        super(state);
    }
}

export class EmitStep extends BaseStep {
    constructor(
        public readonly event: EventDesc,
        state?: StateSnapshot
    ) {
        super(state);
    }
}
