import { BasicStepInfo, getStorage, OpInfo } from "sol-dbg";
import { WithCallInfo } from "./call";
import { WithCreateInfo } from "./create";
import { WithExceptionInfo } from "./exceptions";
import { WithReturnInfo } from "./return";
import { VM } from "@ethereumjs/vm";
import { InterpreterStep } from "@ethereumjs/evm";
import { equalsBytes } from "@ethereumjs/util";
import { storageEq } from "../../observable_events/eq";

type LowerStepT = object &
    BasicStepInfo &
    OpInfo &
    WithCallInfo &
    WithCreateInfo &
    WithReturnInfo &
    WithExceptionInfo;

/**
 * Check we are not missing memory or storage. This transformer is only used for debugging sol-interp/sol-dbg itself.
 * Its slow and shouldnt be used in prod.
 */
export async function checkMemAndStorage<T extends LowerStepT>(
    vm: VM,
    step: InterpreterStep,
    state: T,
    trace: T[]
): Promise<T> {
    const realMem = new Uint8Array(step.memory);
    if (!equalsBytes(realMem, state.memory)) {
        console.error(`Mismatch in memory in step ${trace.length}`);
    }

    const realStorage = await getStorage(vm.stateManager, step.address);
    if (!storageEq(state.storage, realStorage)) {
        console.error(`Diff in storage at step ${trace.length}`);
    }
    return state;
}
