/**
 * Helpers to search for steps in a low-level EVM trace
 */

import { OPCODES, StepState } from "sol-dbg";

export type BoundaryType = "call" | "return" | "exception" | "out-of-gas" | "event"
export type Boundary = [BoundaryType, number]

/**
 * Return true IFF the EVM runs out of gas on the given step.
 * @todo in the presence of EIP-6800 or EIP-7864 its possible to for `lastStep.gasCost` to be less than the true gas cost.
 * (see https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/src/interpreter.ts#L399).
 * In those cases we may miss an out-of-gas exception.
 * 
 * It seems that both are not yet on mainnet.
 * @param step 
 */
function isOutOfGas(step: StepState): boolean {
    return step.gasCost > step.gas;
}

function isReturnOp(op: number): boolean {
    return op === OPCODES.RETURN || op === OPCODES.STOP;
}

/**
 * Find the next trace alignment boundary in `llTrace` start after `afterIdx`.
 */
export function findNextBoundary(llTrace: StepState[], afterIdx: number): Boundary {
    const curDepth = llTrace[afterIdx].depth;

    for (let i = afterIdx + 1; i < llTrace.length; i++) {
        const lastStep = llTrace[i - 1]
        const step = llTrace[i];

        // Call, return, exception or out-of-gas
        if (step.depth !== curDepth) {
            // Call
            if (step.depth === curDepth + 1) {
                return ["call", i]
            }

            if (isOutOfGas(lastStep)) {
                return ["out-of-gas", i]
            }

            // Return
            if (isReturnOp(lastStep.op.opcode) && step.depth === curDepth - 1) {
                return ["return", i]
            }

            // Exception. We don't explicitly check for a specific opcode as many
            // opcodes may trigger an exception
            return ["exception", i]
        }

        if (step.emittedEvent !== undefined) {
            return ["event", i];
        }
    }

    const lastStep = llTrace[llTrace.length - 1]

    if (isOutOfGas(lastStep)) {
        return ["out-of-gas", llTrace.length]
    }

    if (isReturnOp(lastStep.op.opcode) && lastStep.depth === 1) {
        return ["return", llTrace.length]
    }

    return ["exception", llTrace.length]
}