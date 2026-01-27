import {
    BaseCalldataView,
    ArrayLikeView,
    Memory,
    SingleByteCalldataView,
    DecodingFailure,
    PrimitiveValue,
    BaseRuntimeType,
    View,
    BytesType
} from "sol-dbg";
import { bytesT } from "../utils";
import { ppValue } from "../pp";

/**
 * A view to the entire msg.data. We cant just reuse a BytesCalldataView as that assumes a dynamic offset and length.
 */
export class MsgDataView
    extends BaseCalldataView<Uint8Array, BytesType>
    implements ArrayLikeView<Memory, SingleByteCalldataView>
{
    constructor() {
        super(bytesT, 0n, 0n);
    }

    size(state: Memory): bigint {
        return BigInt(state.length);
    }

    indexView(key: bigint, state: Memory): DecodingFailure | SingleByteCalldataView {
        if (key > this.size(state)) {
            return new DecodingFailure(`OoB access in MsgDataView at ${key}`);
        }

        return new SingleByteCalldataView(key, 0n);
    }

    decode(state: Memory): Uint8Array<ArrayBufferLike> | DecodingFailure {
        return state;
    }
}

export class TempView<V extends PrimitiveValue, T extends BaseRuntimeType> extends View<
    null,
    V,
    null,
    T
> {
    val: V | undefined;

    constructor(type: T) {
        super(type, null);
    }

    decode(): V | DecodingFailure {
        if (this.val === undefined) {
            return new DecodingFailure(`Couldn't read an uninitialized temp`);
        }

        return this.val;
    }

    encode(v: V): void {
        this.val = v;
    }

    pp(): string {
        return `<temp ${this.type.pp()}: ${this.val === undefined ? "<uninitialized>" : ppValue(this.val)}>`;
    }
}
