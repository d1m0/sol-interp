import { OPCODES, StepState } from "sol-dbg";

/**
 * Return true IFF the EVM runs out of gas on the given step.
 * @todo in the presence of EIP-6800 or EIP-7864 its possible to for `lastStep.gasCost` to be less than the true gas cost.
 * (see https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/src/interpreter.ts#L399).
 * In those cases we may miss an out-of-gas exception.
 *
 * It seems that both are not yet on mainnet.
 * @param step
 */
export function isOutOfGas(step: StepState): boolean {
    return step.gasCost > step.gas;
}

export function isReturn(step: StepState): boolean {
    return step.op.opcode === OPCODES.RETURN || step.op.opcode === OPCODES.STOP;
}

/**
 * Return true IIF the `idx`-th step of `llTrace` throws an exception.
 */
export function throwsException(llTrace: StepState[], idx: number): boolean {
    const isRet = isReturn(llTrace[idx]);
    // If this is the last step, assume that anything that is not a normal return must be an exception
    if (idx === llTrace.length - 1) {
        return !isRet;
    }

    // Out-of-gas is always an exception
    if (isOutOfGas(llTrace[idx])) {
        return true;
    }

    // Otherwise if depth is decreasing, and this is not a return op, assume its an exception
    return llTrace[idx].depth > llTrace[idx + 1].depth && !isRet;
}
