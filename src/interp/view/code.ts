import * as rtt from "sol-dbg";

export class CodeView<
    Val extends rtt.Value,
    Type extends rtt.BaseRuntimeType = rtt.BaseRuntimeType
> extends rtt.View<rtt.Memory, Val, bigint, Type> {
    innerView: rtt.BaseMemoryView<Val, Type>;

    constructor(type: Type, loc: bigint) {
        super(type, loc);
        this.innerView = rtt.makeMemoryView(type, loc) as rtt.BaseMemoryView<Val, Type>;
    }

    decode(state: Uint8Array): Val | rtt.DecodingFailure {
        return this.innerView.decode(state);
    }

    encode(value: Val, state: Uint8Array): void {
        /**
         * Since all immutables are value-type only, and they have space pre-allocated in their code,
         * we should never call an allocator when encoding. So it should be safe to pass `undefined` below
         * for allocator
         */
        this.innerView.encode(value, state, undefined as unknown as any);
    }

    pp(): string {
        return `<${this.type.pp()}@${this.loc} in code>`;
    }
}
