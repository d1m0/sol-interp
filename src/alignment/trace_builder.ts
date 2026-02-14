import {
    Address,
    bigIntToBytes,
    createAccount,
    createAddressFromString,
    setLengthLeft
} from "@ethereumjs/util";
import { AccountMap, CallResult, Chain, SolMessage } from "../interp/env";
import { ArtifactManager } from "../interp/artifactManager";
import { AlignedTracesPair, AlignedTraces } from "./aligned_traces";
import { BaseStep, EmitStep, EvalStep, ExecStep } from "../interp/step";
import { createTx, TypedTransaction, TypedTxData } from "@ethereumjs/tx";
import { BlockData, createBlock } from "@ethereumjs/block";
import { EventDesc, SolTxDebugger, StepState, ZERO_ADDRESS } from "sol-dbg";
import { Common, Hardfork, Mainnet, StateManagerInterface } from "@ethereumjs/common";
import { MerkleStateManager } from "@ethereumjs/statemanager";
import { RunTxResult } from "@ethereumjs/vm";
import * as sol from "solc-typed-ast";
import { Interpreter } from "../interp";
import { RuntimeError } from "../interp/exceptions";
import { State } from "../interp/state";
import { Value, LValue } from "../interp/value";
import { findCall, findEmit, findException, findReturn } from "./seek";

/**
 * Build a `MerkleStateManager` corresponding to the provided `initialState`.
 * @param initialState
 * @returns
 */
async function makeStateManager(initialState: AccountMap): Promise<MerkleStateManager> {
    const state = new MerkleStateManager();
    await state.checkpoint();

    for (const [addressStr, accountInfo] of initialState.entries()) {
        const nonce = accountInfo.nonce;
        const balance = accountInfo.balance;
        const codeBuf = accountInfo.deployedBytecode;
        const storage = accountInfo.storage;

        const address = createAddressFromString(addressStr);

        const acct = createAccount({
            nonce: BigInt(nonce),
            balance: BigInt(balance)
        });

        await state.putAccount(address, acct);

        for (const [key, valBuf] of storage.entries()) {
            const keyBuf = setLengthLeft(bigIntToBytes(key), 32);

            await state.putStorage(address, keyBuf, valBuf);
        }

        await state.putCode(address, codeBuf);
    }

    await state.commit();
    await state.flush();

    return state;
}

export function getCommon(): Common {
    return new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
}

export function makeFakeTransaction(
    txData: TypedTxData,
    sender: Address,
    common: Common
): TypedTransaction {
    const tx = createTx(txData, { common, freeze: false });

    /**
     *  Fake the signature
     */
    tx.getSenderAddress = () => sender;
    tx.isSigned = () => true;
    return tx;
}

async function replayEVM(
    artifactManager: ArtifactManager,
    initialState: AccountMap,
    txData: TypedTxData,
    blockData: BlockData,
    sender: Address
): Promise<[StepState[], RunTxResult, StateManagerInterface, TypedTransaction]> {
    const common = getCommon();
    const tx = makeFakeTransaction(txData, sender, common);

    const block = createBlock(blockData, { common });
    const stateManager = await makeStateManager(initialState);

    const tracer = new SolTxDebugger(artifactManager, { strict: false });
    const [trace, res, stateAfter] = await tracer.debugTx(tx, block, stateManager);

    return [trace, res, stateAfter, tx];
}

/**
 * Given a `TypedTxData` `tx` and a `sender` `Address` build the corresponding `SolMessage`.
 */
function makeSolMessage(tx: TypedTransaction, sender: Address): SolMessage {
    return {
        from: sender,
        delegatingContract: undefined,
        to: tx.to === undefined ? ZERO_ADDRESS : tx.to,
        data: tx.data,
        gas: tx.gasLimit,
        value: tx.value,
        salt: undefined,
        isStaticCall: false
    };
}

/**
 * Given an initial account state, tx and block data, and an artifactManager:
 * 1. Replay the TX and generate an EVM debug trace
 * 2. Interepter the TX at the Solidity level
 * 3. Align the 2 traces and return an aligned traces tree
 */
export async function buildAlignedTraces(
    initialState: AccountMap,
    txData: TypedTxData,
    sender: Address,
    blockData: BlockData,
    artifactManager: ArtifactManager
): Promise<[AlignedTraces<StepState, BaseStep>, CallResult, AccountMap]> {
    // 1. Get the low-level trace
    const [trace, , , tx] = await replayEVM(
        artifactManager,
        initialState,
        txData,
        blockData,
        sender
    );

    // 2. Interpret at the Solidity level
    const builder = new AlignedTraceBuilder(
        artifactManager,
        initialState,
        trace,
        makeSolMessage(tx, sender)
    );
    return builder.buildAlignedTraces();
}

class AlignedTraceBuilder extends Chain {
    currentLLIdx = 0;
    highLevelTrace: BaseStep[] = [];
    alignedTracesStack: Array<Array<AlignedTracesPair<StepState, BaseStep>>> = [[]];

    constructor(
        artifactManager: ArtifactManager,
        initialState: AccountMap,
        private readonly lowLevelTrace: StepState[],
        private readonly msg: SolMessage
    ) {
        super(artifactManager, initialState);
    }

    buildAlignedTraces(): [AlignedTraces<StepState, BaseStep>, CallResult, AccountMap] {
        const env = this;

        const visitor = {
            call: function (interp: Interpreter, state: State, msg: SolMessage): void {
                const callIdx = findCall(env.lowLevelTrace, env.currentLLIdx);
                sol.assert(callIdx !== undefined, `NYI failure handling`);

                const lowLevelTrace = env.lowLevelTrace.slice(env.currentLLIdx, callIdx);
                const highLevelSlice = env.highLevelTrace;

                env.alignedTracesStack[env.alignedTracesStack.length - 1].push([
                    lowLevelTrace,
                    highLevelSlice,
                    null
                ]);
                env.alignedTracesStack.push([]);

                env.highLevelTrace = [];
                env.currentLLIdx = callIdx;
            },
            return: function (interp: Interpreter, state: State, res: Uint8Array): void {
                const returnIdx = findReturn(env.lowLevelTrace, env.currentLLIdx);
                sol.assert(returnIdx !== undefined, `NYI failure handling`);

                const lowLevelTrace = env.lowLevelTrace.slice(env.currentLLIdx, returnIdx);
                const highLevelSlice = env.highLevelTrace;

                env.alignedTracesStack[env.alignedTracesStack.length - 1].push([
                    lowLevelTrace,
                    highLevelSlice,
                    null
                ]);

                if (env.alignedTracesStack.length > 0) {
                    const newTrace = env.alignedTracesStack.pop() as Array<
                        AlignedTracesPair<StepState, BaseStep>
                    >;
                    const stackTop = env.alignedTracesStack[env.alignedTracesStack.length - 1];
                    sol.assert(stackTop.length > 0, ``);
                    sol.assert(stackTop[stackTop.length - 1][2] === null, ``);

                    stackTop[stackTop.length - 1][2] = newTrace;
                }

                env.highLevelTrace = [];
                env.currentLLIdx = returnIdx;
            },
            exception: function (interp: Interpreter, state: State, err: RuntimeError): void {
                const excIdx = findException(env.lowLevelTrace, env.currentLLIdx);
                sol.assert(excIdx !== undefined, `NYI failure handling`);

                const depthChange =
                    env.lowLevelTrace[excIdx - 1].depth - env.lowLevelTrace[excIdx].depth;
                const lowLevelTrace = env.lowLevelTrace.slice(env.currentLLIdx, excIdx);
                const highLevelSlice = env.highLevelTrace;

                env.alignedTracesStack[env.alignedTracesStack.length - 1].push([
                    lowLevelTrace,
                    highLevelSlice,
                    null
                ]);

                for (let i = 0; i < depthChange; i++) {
                    if (env.alignedTracesStack.length > 0) {
                        const newTrace = env.alignedTracesStack.pop() as Array<
                            AlignedTracesPair<StepState, BaseStep>
                        >;
                        const stackTop = env.alignedTracesStack[env.alignedTracesStack.length - 1];
                        sol.assert(stackTop.length > 0, ``);
                        sol.assert(stackTop[stackTop.length - 1][2] === null, ``);

                        stackTop[stackTop.length - 1][2] = newTrace;
                    }
                }

                env.highLevelTrace = [];
                env.currentLLIdx = excIdx;
            },
            exec: function (interp: Interpreter, state: State, stmt: sol.Statement): void {
                env.highLevelTrace.push(new ExecStep(stmt));
            },
            eval: function (
                interp: Interpreter,
                state: State,
                expr: sol.Expression,
                val: Value | LValue
            ): void {
                env.highLevelTrace.push(new EvalStep(expr, val));
            },
            emit: function (interp: Interpreter, state: State, event: EventDesc): void {
                const emitIdx = findEmit(env.lowLevelTrace, env.currentLLIdx);
                sol.assert(emitIdx !== undefined, `NYI failure handling`);
                env.currentLLIdx = emitIdx;
                env.highLevelTrace.push(new EmitStep(event));
            }
        };

        this.addVisitor(visitor);
        const interpRes = this.execMsg(this.msg);
        console.error(interpRes);

        sol.assert(env.alignedTracesStack.length === 1, ``);
        return [env.alignedTracesStack[0], interpRes, this.state];
    }
}
