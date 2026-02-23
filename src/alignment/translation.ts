import { StepState } from "sol-dbg";
import * as sol from "solc-typed-ast"
import { CallResult } from "../interp";
import { isReturn, throwsException } from "./traces";

export function getResultFromStep(llTrace: StepState[], idx: number): CallResult {
    sol.assert(idx > 0, ``)
    const lastStep = llTrace[idx - 1];
    const step = llTrace[idx];

    if (isReturn(lastStep)) {
        sol.assert(step.retInfo !== undefined, ``);
        return {
            reverted: false,
            data: step.retInfo.rawReturnData,
            newContract: step.contractCreated
        }
    }

    sol.assert(throwsException(llTrace, idx - 1), ``);
    sol.assert(lastStep.excInfo !== undefined, ``)

    return {
        reverted: true,
        data: lastStep.excInfo.data
    }
}