import { Expression, Statement } from "solc-typed-ast";
import { LValue, Value } from "./value";
import { CallResult, SolMessage } from "./state";
import { RuntimeError } from "./exceptions";

export abstract class BaseStep {}

export type Trace = BaseStep[];

export class EvalStep extends BaseStep {
    constructor(
        public readonly expr: Expression,
        public readonly val: Value | LValue
    ) {
        super();
    }
}

export class ExecStep extends BaseStep {
    constructor(public readonly stmt: Statement) {
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
