import { ContractInfo } from "sol-dbg";
import { BaseStep } from "../interp";
import { ArtifactManager } from "../interp/artifactManager";
import { EVMStep } from "./evm_trace";
import { EVMObservableEvent, SolObservableEvent } from "./observable_events";

// Pair misaligned due to some condition
export type MisalignedPairTypes =
    | "misaligned:out-of-gas"
    | "misaligned:inline_asm"
    | "misaligned:error";

export type PairTypes = "aligned" | MisalignedPairTypes | "no-source";

export function isMisalignmentPairType(t: string): t is MisalignedPairTypes {
    return (
        t === "misaligned:out-of-gas" || t === "misaligned:inline_asm" || t === "misaligned:error"
    );
}

export interface BasePair {
    type: PairTypes;
    llTrace: EVMStep[];
    llEndEvent: EVMObservableEvent;
}

export interface AlignedPair extends BasePair {
    type: "aligned";
    hlTrace: BaseStep[];
    hlEndEvent: SolObservableEvent;
}

export interface MisalignedPair extends BasePair {
    type: MisalignedPairTypes;
    hlTrace?: BaseStep[];
    hlEndEvent?: SolObservableEvent;
}

export interface NoSourcePair extends BasePair {
    type: "no-source";
}

export type TracePair = AlignedPair | MisalignedPair | NoSourcePair;
export type AlignedTraces = TracePair[];

export function isAligned(p: TracePair): p is AlignedPair {
    return p.type === "aligned";
}

export function isMisaligned(p: TracePair): p is MisalignedPair {
    return isMisalignmentPairType(p.type);
}

export function isNoSource(p: TracePair): p is NoSourcePair {
    return p.type === "no-source";
}

export function hasMisaligned(ps: AlignedTraces, type?: MisalignedPairTypes): boolean {
    for (const p of ps) {
        if (type === undefined) {
            if (isMisaligned(p)) {
                return true;
            }
        } else {
            if (p.type === type) {
                return true;
            }
        }
    }

    return false;
}

export function hasAligned(ps: AlignedTraces): boolean {
    for (const p of ps) {
        if (isAligned(p)) {
            return true;
        }
    }

    return false;
}

export function hasNoSource(ps: AlignedTraces): boolean {
    for (const p of ps) {
        if (isNoSource(p)) {
            return true;
        }
    }

    return false;
}

export function isAllNoSource(ps: AlignedTraces): boolean {
    for (const p of ps) {
        if (!isNoSource(p)) {
            return false;
        }
    }

    return true;
}

/**
 * Return true IFF t is well formed. We consider a pair of aligned traces to be well formed if:
 *
 * 1. The low-level traces in `t` concatenated equal the original low-level trace `llTrace`
 * 2. For every segment s (trace pair) in `t`:
 *      - if the running bytecode in s is found in `artifactManager` and has sources, then the pair
 *          must either be `aligned` or `misaligned`
 *      - if the running bytecode in s is NOT found in `artifactManager` then the segment must be `no-source`
 * @param t
 */
export function alignedTraceWellFormed(
    t: AlignedTraces,
    llTrace: EVMStep[],
    artifactManager: ArtifactManager,
    addrToInfoMap: Map<string, ContractInfo> | undefined = undefined
): boolean {
    const llTraceFromAligned: EVMStep[] = [];
    for (const segment of t) {
        llTraceFromAligned.push(...segment.llTrace);
    }

    // Alignment covers original llTrace
    if (llTraceFromAligned.length !== llTrace.length) {
        return false;
    }

    for (let i = 0; i < llTraceFromAligned.length; i++) {
        if (llTraceFromAligned[i] !== llTrace[i]) {
            return false;
        }
    }

    // Check we only have no-source segments for ll trace segments with no ast in the artifact manager
    for (const segment of t) {
        // Ignore segments corresponding to calls to contracts with no code
        if (segment.llTrace.length === 0) {
            continue;
        }

        const step = segment.llTrace[0];
        let info: ContractInfo | undefined;

        if (addrToInfoMap) {
            const addr = step.codeAddress !== undefined ? step.codeAddress : step.address;
            info = addrToInfoMap.get(addr.toString());
        } else {
            info = step.codeInfo.isCreation
                ? artifactManager.getContractFromCreationBytecode(step.codeInfo.code)
                : artifactManager.getContractFromDeployedBytecode(step.codeInfo.code);
        }

        const hasAST = info !== undefined && info.ast !== undefined;

        if (hasAST && segment.type === "no-source") {
            return false;
        }

        if (!hasAST && segment.type !== "no-source") {
            return false;
        }
    }

    return true;
}
