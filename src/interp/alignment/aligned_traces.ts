/**
 * Class representing two aligned call-trees containing low-level and high-level traces
 */
export class AlignedTraces<LowLevelStep, HighLevelStep> {
    constructor(
        public readonly inner: Array<
            [LowLevelStep[], HighLevelStep[], AlignedTraces<LowLevelStep, HighLevelStep>]
        >,
        public readonly final: [LowLevelStep[], HighLevelStep[]]
    ) {}
}
