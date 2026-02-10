import * as sol from "solc-typed-ast";
import { LValue, Value } from "./value";
import { RuntimeError } from "./exceptions";
import { EventDesc } from "sol-dbg";
import { CallResult, SolMessage } from "./env";

export abstract class BaseStep {}

export type Trace = BaseStep[];

export class EvalStep extends BaseStep {
    constructor(
        public readonly expr: sol.Expression,
        public readonly val: Value | LValue
    ) {
        super();
    }
}

export class ExecStep extends BaseStep {
    constructor(public readonly stmt: sol.Statement) {
        super();
    }
}

export class ExtCallStep extends BaseStep {
    constructor(public readonly msg: SolMessage) {
        super();
    }
}

export class ExtReturnStep extends BaseStep {
    constructor(public readonly res: CallResult) {
        super();
    }
}

export class ExceptionStep extends BaseStep {
    constructor(public readonly exception: RuntimeError) {
        super();
    }
}

export class EmitStep extends BaseStep {
    constructor(public readonly event: EventDesc) {
        super();
    }
}
