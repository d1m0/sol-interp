import { StepState } from "sol-dbg";
import { ArtifactManager } from "../artifactManager";
import { AlignedTraces } from "./aligned_traces";
import { BaseStep } from "../step";

/**
 * Given an `ArtifactManager` with known artifacts, and a low-level debug trace,
 * build an aligne traces tree between the low-level trace and a solidity
 * interpreter state. To do this, starting at position X_low (initially 0) in the low-level trace and X_high in the high-level trace (initially 0):
 *  1) finding the next call/return/exception Y_low in the low-level trace after X_low
 *  2) running the interpreter from X_high until it hits a corresponding call/return/exception at Y_high
 *  3) Verify that the states at Y_low and Y_high are the same (same state and same call args/call returns/exception data)
 *  4) Add the trace pair [X_low: Y_low], [X_high, Y_high] to the current tree node
 *  5) If this is a call call `buildAlignedCallTree()` recurisvely
 *  6) If this is a return/exception return the current tree node
 */
export function buildAlignedCallTree(artifactManager: ArtifactManager, lowLevelTrace: StepState[], pos = 0): AlignedTraces<StepState, BaseStep> {
    const node
}