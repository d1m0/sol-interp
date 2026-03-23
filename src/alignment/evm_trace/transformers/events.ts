import { VM } from "@ethereumjs/vm";
import { BasicStepInfo, EventDesc, mustReadMem, stackTop, stackInd } from "sol-dbg";
import { InterpreterStep } from "@ethereumjs/evm";

export interface WithEventInfo {
    emittedEvent: EventDesc | undefined;
}

/**
 * Adds source info for each step (if available)
 */
export async function addEventInfo<T extends object & BasicStepInfo>(
    vm: VM,
    step: InterpreterStep,
    state: T
): Promise<T & WithEventInfo> {
    let emittedEvent: EventDesc | undefined = undefined;

    // Finally check if an event is being emitted for this step
    if (step.opcode.name.startsWith("LOG")) {
        const stack = state.evmStack;

        const nTopics = (step.opcode.name[3] as any) - ("0" as any);
        const payload = mustReadMem(stackTop(stack), stackInd(stack, 1), state.memory);

        emittedEvent = {
            payload,
            topics: stack.slice(stack.length - 2 - nTopics, stack.length - 2).reverse()
        };
    }

    return {
        emittedEvent,
        ...state
    };
}
