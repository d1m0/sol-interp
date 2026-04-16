import * as rtt from "sol-dbg";

/**
 * The compiler may optimize away unused immutables. For those we generate a
 * throw-away temp view, so that we can initialie them during the constructor.
 * We are ok with throwing it away after the constructor, as it should never be
 * referenced again.
 */
export class OptimizedImmutable<
    Val extends rtt.Value,
    Type extends rtt.BaseRuntimeType = rtt.BaseRuntimeType
> extends rtt.View<rtt.Memory, Val, null, Type> {
    val?: Val;

    constructor(type: Type) {
        super(type, null);
    }

    decode(): Val | rtt.DecodingFailure {
        if (this.val === undefined) {
            return new rtt.DecodingFailure(`Accessing uninitialized optimized-away immutable.`);
        }
        return this.val;
    }

    encode(value: Val): void {
        this.val = value;
    }

    pp(): string {
        return `<optimizied away immutable of type ${this.type.pp()}>`;
    }
}
