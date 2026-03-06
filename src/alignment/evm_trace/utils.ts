import { BasicStepInfo, OPCODES, OpInfo } from "sol-dbg";
import { EVMStep } from "./tracer";
import { AccountMap } from "../../interp";
import { assert } from "../../utils";

/**
 * Return true IFF the EVM runs out of gas on the given step.
 * @todo in the presence of EIP-6800 or EIP-7864 its possible to for `lastStep.gasCost` to be less than the true gas cost.
 * (see https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/evm/src/interpreter.ts#L399).
 * In those cases we may miss an out-of-gas exception.
 *
 * It seems that both are not yet on mainnet.
 * @param step
 * @todo move to sol-dbg
 */
export function isOutOfGas(step: BasicStepInfo): boolean {
    return step.gasCost > step.gas;
}

// @todo move to sol-dbg
export function isReturn(step: OpInfo): boolean {
    return step.op.opcode === OPCODES.RETURN || step.op.opcode === OPCODES.STOP;
}

// @todo move to sol-dbg
export function isCall(step: OpInfo): boolean {
    return (
        step.op.opcode === OPCODES.CALL ||
        step.op.opcode === OPCODES.CALLCODE ||
        step.op.opcode === OPCODES.STATICCALL ||
        step.op.opcode === OPCODES.DELEGATECALL
    );
}

export function isCreate(step: OpInfo): boolean {
    return step.op.opcode === OPCODES.CREATE || step.op.opcode === OPCODES.CREATE2;
}

/**
 * Given an `initialState` and a trace, rebuild the state of all accounts up to (and including) index `idx` of the trace.
 */
export function rebuildStateFromTrace(
    trace: EVMStep[],
    initialState: AccountMap,
    idx: number
): AccountMap {
    let state = initialState;
    const stateMap = new Map<number, AccountMap>();

    stateMap.set(-1, initialState);

    for (let i = 0; i <= idx; i++) {
        const step = trace[i];
        const lastStep = trace.length > 0 ? trace[trace.length - 1] : undefined;

        if (step.callInfo || step.createInfo || step.returnInfo) {
            assert(step.snapshot !== undefined, ``);
            state = state.set(step.address.toString(), step.snapshot);
            stateMap.set(i, state);
        } else if (lastStep && lastStep.exceptionInfo) {
            const oldState = stateMap.get(lastStep.exceptionInfo.correspCallIdx);
            assert(oldState !== undefined && step.snapshot !== undefined, ``);
            // Restore the caller contract to the recorded state right after the exception.
            // This is mostly to get the right nonce after a failed contract creation.
            state = oldState.set(step.address.toString(), step.snapshot);
        }

        // Right after SELFDESTRUCT delete the destroyed contract
        if (
            lastStep &&
            lastStep.op.opcode === OPCODES.SELFDESTRUCT &&
            lastStep.exceptionInfo === undefined
        ) {
            state = state.delete(lastStep.address.toString());
        }
    }

    return state;
}
