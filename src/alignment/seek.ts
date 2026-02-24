/**
 * Helpers to search for steps in a low-level EVM trace
 */

import { StepState } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { isOutOfGas, isReturn } from "./traces";

export type BoundaryType = "call" | "return" | "exception" | "out-of-gas" | "event";
export type Boundary = [BoundaryType, number];

/**
 * Find the next trace alignment boundary in `llTrace` start after `afterIdx`.
 */
export function findNextBoundary(llTrace: StepState[], afterIdx: number): Boundary {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const lastStep = llTrace[i - 1];
        const step = llTrace[i];

        // Call, return, exception or out-of-gas
        if (step.depth !== curDepth) {
            // Call
            if (step.depth === curDepth + 1) {
                return ["call", i];
            }

            if (isOutOfGas(lastStep)) {
                return ["out-of-gas", i];
            }

            // Return
            if (isReturn(lastStep) && step.depth === curDepth - 1) {
                return ["return", i];
            }

            // Exception. We don't explicitly check for a specific opcode as many
            // opcodes may trigger an exception
            return ["exception", i];
        }

        if (step.emittedEvent !== undefined) {
            return ["event", i];
        }
    }

    const lastStep = llTrace[llTrace.length - 1];

    if (isOutOfGas(lastStep)) {
        return ["out-of-gas", llTrace.length];
    }

    if (isReturn(lastStep) && lastStep.depth === 1) {
        return ["return", llTrace.length];
    }

    return ["exception", llTrace.length];
}

/**
 * Find the first index `i` in `llTrace` after `afterIdx` at depth `depth`. If the trace depth becomes less than `depth` before
 * reaching `depth`, or we never reach `depth` return -1.
 */
export function findFirstIdxAtDepthAfter(
    llTrace: StepState[],
    depth: number,
    afterIdx: number
): number {
    sol.assert(llTrace[afterIdx].depth > depth, `After idx must be at a higher depth`);
    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        if (llTrace[i].depth < depth) {
            return -1;
        }

        if (llTrace[i].depth == depth) {
            return i;
        }
    }

    return -1;
}
