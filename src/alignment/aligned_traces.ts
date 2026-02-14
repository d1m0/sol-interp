export type AlignedTracesPair<LowLevelStep, HighLevelStep> = [
    LowLevelStep[],
    HighLevelStep[],
    Array<AlignedTracesPair<LowLevelStep, HighLevelStep>> | Error | null
];
export type AlignedTraces<LLStep, HLStep> = Array<AlignedTracesPair<LLStep, HLStep>>;
