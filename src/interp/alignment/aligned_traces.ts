/**
 * Class representing a call-tree with 2 aligned traces
 */
export class AlignedTraces<LowLevelStep, HighLevelStep> {
    constructor(
        public readonly inner: [LowLevelStep[], HighLevelStep[], AlignedTraces<LowLevelStep, HighLevelStep>][],
        public readonly final: [LowLevelStep[], HighLevelStep[]],
    ) {

    }
}