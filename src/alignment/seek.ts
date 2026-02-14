/**
 * Helpers to search for steps in a low-level EVM trace
 */

import { OPCODES, StepState } from "sol-dbg";

/**
 * Scan `llTrace` starting at `afterIdx+1`.
 * If we hit a call, return the first index in the new calling context.
 * Otherwise if the call depth changes, or we reach end of the trace, return -1
 * Also if we hit an event emission first return -1;
 */
export function findCall(llTrace: StepState[], afterIdx: number): number {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const step = llTrace[i];
        if (step.depth === curDepth + 1) {
            return i;
        }

        if (step.depth !== curDepth) {
            return -1;
        }

        if (step.emittedEvent !== undefined) {
            return -1;
        }
    }

    return -1;
}

/**
 * Scan `llTrace` starting at `afterIdx+1`.
 * If we hit a return, return the first index in the caller context.
 * Otherwise if the call depth changes, or we reach end of the trace, return -1
 * Also if we hit an event emission first return -1;
 */
export function findReturn(llTrace: StepState[], afterIdx: number): number {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const step = llTrace[i];
        if (step.depth === curDepth - 1) {
            // Don't match exceptions
            if (llTrace[i - 1].op.opcode !== OPCODES.RETURN) {
                return -1;
            }

            return i;
        }

        if (step.depth !== curDepth) {
            return -1;
        }

        if (step.emittedEvent !== undefined) {
            return -1;
        }
    }

    return -1;
}

/**
 * Scan `llTrace` starting at `afterIdx+1`.
 * If we hit an exception, return the first index in the catching context.
 * Otherwise if the call depth changes, or we reach end of the trace, return -1
 * Also if we hit an event emission first return -1;
 *
 * Note that we may have both explicit (revert, invalid) exceptions, as well as
 * implicit (gas, arithmetic, ...) exceptions.
 */
export function findException(llTrace: StepState[], afterIdx: number): number {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const step = llTrace[i];
        if (step.depth < curDepth) {
            // Don't match returns
            if (llTrace[i - 1].op.opcode === OPCODES.RETURN) {
                return -1;
            }

            return i;
        }

        if (step.depth !== curDepth) {
            return -1;
        }

        if (step.emittedEvent !== undefined) {
            return -1;
        }
    }

    return -1;
}

/**
 * Scan `llTrace` starting at `afterIdx+1`.
 * If we hit an event emission, return the index of the emit function.
 * If the call depth changes, or we reach end of the trace, return -1
 */
export function findEmit(llTrace: StepState[], afterIdx: number): number {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const step = llTrace[i];
        if (step.depth !== curDepth) {
            return -1;
        }

        if (step.emittedEvent !== undefined) {
            return i;
        }
    }

    return -1;
}
