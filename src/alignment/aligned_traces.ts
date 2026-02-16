export type AlignedTracesPair<LowLevelStep, HighLevelStep> = [
    LowLevelStep[],
    HighLevelStep[],
    Array<AlignedTracesPair<LowLevelStep, HighLevelStep>> | Error | null
];
export type AlignedTraces<LLStep, HLStep> = Array<AlignedTracesPair<LLStep, HLStep>>;

export function lastPair<LLStep, HLStep>(
    t: AlignedTraces<LLStep, HLStep>
): AlignedTracesPair<LLStep, HLStep> | undefined {
    if (t.length === 0) {
        return undefined;
    }

    const p = t[t.length - 1];
    if (p[2] instanceof Array) {
        return lastPair(p[2]);
    }

    return p;
}

export function areAligned<LLStep, HLStep>(t: AlignedTraces<LLStep, HLStep>): boolean {
    const last = lastPair(t);

    // Empty traces are always aligned
    if (last === undefined) {
        return true;
    }

    return last[2] === null;
}
