import { Expression, Statement } from "solc-typed-ast";
import { LValue, Value } from "./value";

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
