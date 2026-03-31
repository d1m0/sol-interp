import { InterpreterStep } from "@ethereumjs/evm";
import { VM } from "@ethereumjs/vm";
import {
    addBasicInfo,
    addOpInfo,
    StepVMState,
    EventDesc,
    BaseSolTxTracer,
    TracerOpts,
    FoundryTxResult,
    OPCODES
} from "sol-dbg";
import {
    addCallInfo,
    addCreateInfo,
    addEventInfo,
    addExceptionInfo,
    addReturnInfo,
    CallInfo,
    CreateInfo,
    ExceptionInfo,
    ReturnInfo
} from "./transformers";
import { TypedTransaction } from "@ethereumjs/tx";
import { addSnapshotInfo, SnapshotInfo } from "./transformers/state_snapshot";
import { ArtifactManager } from "../../interp/artifactManager";
import { addCodeInfo, CodeInfo } from "./transformers/code";
import { Block } from "@ethereumjs/block";
import { StateManagerInterface } from "@ethereumjs/common";
import { assert } from "../../utils";

/**
 * Annotated evm step struct used for aligning traces.
 */
export interface EVMStep extends StepVMState {
    createInfo: CreateInfo | undefined;
    callInfo: CallInfo | undefined;
    returnInfo: ReturnInfo | undefined;
    emittedEvent: EventDesc | undefined;
    exceptionInfo: ExceptionInfo | undefined;
    snapshotInfo: SnapshotInfo | undefined;
    codeInfo: CodeInfo;
}

interface TracerContext {
    // Stack of indexes of the current *CALL* instructions
    callStack: number[];
}

export class EVMTracer extends BaseSolTxTracer<EVMStep, TracerContext> {
    constructor(opts: TracerOpts = {}) {
        // Artifact Manager not used in this tracer
        super(new ArtifactManager([]), { strict: false, foundryCheatcodes: false, ...opts });
    }

    async debugTx(
        tx: TypedTransaction,
        block: Block,
        stateBefore: StateManagerInterface,
        ctx: TracerContext
    ): Promise<[EVMStep[], FoundryTxResult, StateManagerInterface, TracerContext]> {
        const [trace, txRes, stateAfter, tracerCtx] = await super.debugTx(
            tx,
            block,
            stateBefore,
            ctx
        );

        // Fix-up last step to account for traces ending with a weird exception
        const lastStep = trace[trace.length - 1];

        // If the trace doesnt terminate with a known return or an exception, assume that it terminates with an unknown exception
        if (lastStep.returnInfo === undefined && lastStep.exceptionInfo === undefined) {
            assert(
                !new Set([
                    OPCODES.RETURN,
                    OPCODES.REVERT,
                    OPCODES.SELFDESTRUCT,
                    OPCODES.REVERT
                ]).has(lastStep.op.opcode),
                `Unexpected last opcode with missing info {0}`,
                lastStep.op.mnemonic
            );
            lastStep.exceptionInfo = {
                excData: new Uint8Array(),
                isImplicit: true,
                correspCallIdx: -1
            };
        }

        return [trace, txRes, stateAfter, tracerCtx];
    }

    async processRawTraceStep(
        vm: VM,
        step: InterpreterStep,
        trace: EVMStep[],
        tx: TypedTransaction,
        ctx: TracerContext
    ): Promise<[EVMStep, TracerContext]> {
        const opInfo = addOpInfo(vm, step, {});
        const basicInfo = await addBasicInfo(vm, step, opInfo, trace);
        const events = await addEventInfo(vm, step, basicInfo);
        const withCreate = await addCreateInfo(vm, step, events, trace, ctx.callStack);
        const withCall = await addCallInfo(vm, step, withCreate, trace, ctx.callStack);
        const withRet = await addReturnInfo(vm, step, withCall, trace, ctx.callStack, tx);
        const withExceptions = await addExceptionInfo(vm, step, withRet, trace, ctx.callStack);
        const withSnapshot = await addSnapshotInfo(vm, step, withExceptions, trace, tx);
        const withCode = await addCodeInfo(vm, step, withSnapshot, trace, tx);

        return [withCode, ctx];
    }
}
