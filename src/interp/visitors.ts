import { RuntimeError } from "./exceptions";
import { Interpreter } from "./interp";
import { State } from "./state";
import * as sol from "solc-typed-ast";
import { LValue, Value } from "./value";
import {
    EmitStep,
    EvalStep,
    ExceptionStep,
    ExecStep,
    ExtCallStep,
    ExtReturnStep,
    Trace
} from "./step";
import { EventDesc, ZERO_ADDRESS } from "sol-dbg";
import { getThis } from "./utils";
import { CallResult, SolMessage } from "./env";

export interface InterpVisitor {
    call(interp: Interpreter, state: State, msg: SolMessage): void;
    return(interp: Interpreter, state: State, res: Uint8Array): void;
    exception(interp: Interpreter, state: State, err: RuntimeError): void;
    exec(interp: Interpreter, state: State, stmt: sol.Statement): void;
    eval(interp: Interpreter, state: State, expr: sol.Expression, val: Value | LValue): void;
    emit(interp: Interpreter, state: State, event: EventDesc): void;
}

export class TraceVisitor implements InterpVisitor {
    trace: Trace = [];

    getTrace(): Trace {
        return this.trace;
    }

    call(interp: Interpreter, state: State, msg: SolMessage): void {
        this.trace.push(new ExtCallStep(msg));
    }

    return(interp: Interpreter, state: State, data: Uint8Array): void {
        const res: CallResult = {
            reverted: false,
            data
        };

        if (state.msg.to.equals(ZERO_ADDRESS)) {
            res.newContract = getThis(state);
        }

        this.trace.push(new ExtReturnStep(res));
    }

    exception(interp: Interpreter, state: State, err: RuntimeError): void {
        this.trace.push(new ExceptionStep(err));
    }

    exec(interp: Interpreter, state: State, stmt: sol.Statement): void {
        this.trace.push(new ExecStep(stmt));
    }

    eval(interp: Interpreter, state: State, expr: sol.Expression, val: Value | LValue): void {
        this.trace.push(new EvalStep(expr, val));
    }

    emit(interp: Interpreter, state: State, event: EventDesc): void {
        this.trace.push(new EmitStep(event));
    }
}
