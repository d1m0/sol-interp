import { BaseEEI } from "./base_eei";

/**
 * Interpreter-only EEI. Doesn't support low-level routines like gasleft()
 */
export class InterpEEI extends BaseEEI {
    gasleft(): bigint {
        throw new Error("gasleft() not support when doing pure interpretation");
    }
}
