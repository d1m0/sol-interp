import {
    View,
    DecodingFailure,
    EncodingError,
    PrimitiveValue,
    PointerView,
    Value,
    isPointerView as baseIsPointerView,
    ArrayLikeView,
    isArrayLikeMemView,
    isArrayLikeCalldataView,
    isArrayLikeStorageView,
    BaseRuntimeType,
    FixedBytesType,
    PointerType
} from "sol-dbg";
import { BaseScope } from "./scope";
import { isFailure } from "sol-dbg/dist/debug/decoding/utils";
import { bytes1 } from "./utils";

export abstract class BaseLocalView<
    V extends PrimitiveValue,
    T extends BaseRuntimeType
> extends View<null, V, [BaseScope, string], T> {
    decode(): V | DecodingFailure {
        const [scope, name] = this.loc;
        const res = scope._lookup(name);

        if (res === undefined) {
            return new DecodingFailure(`Couldn't find ${name} in ${scope.name}`);
        }

        return res as V;
    }
    encode(v: V): void {
        const [scope, name] = this.loc;
        scope._set(name, v);
    }
    pp(): string {
        return `<local ${this.loc[1]}@${this.loc[0].name}>`;
    }

    get name(): string {
        return this.loc[1];
    }
}

export class PrimitiveLocalView extends BaseLocalView<PrimitiveValue, BaseRuntimeType> {}

export class SingleByteLocalView extends BaseLocalView<bigint, FixedBytesType> {
    constructor(
        loc: [BaseScope, string],
        private byteOffset: number
    ) {
        super(bytes1, loc);
    }

    decode(): bigint | DecodingFailure {
        const [scope, name] = this.loc;
        const word = scope._lookup(name);

        if (!(word instanceof Uint8Array)) {
            return new DecodingFailure(
                `Expected an Uint8Array for ${name} in ${scope.name} not ${word}`
            );
        }

        if (this.byteOffset < 0n || this.byteOffset >= word.length) {
            return new DecodingFailure(`OoB index ${this.byteOffset} in ${name} in ${scope.name}`);
        }

        return BigInt(word[this.byteOffset]);
    }

    encode(v: bigint): void {
        const [scope, name] = this.loc;
        const word = scope._lookup(name);

        if (!(word instanceof Uint8Array)) {
            throw new EncodingError(
                `Expected an Uint8Array for ${name} in ${scope.name} not ${word}`
            );
        }

        if (this.byteOffset < 0n || this.byteOffset >= word.length) {
            throw new EncodingError(`OoB index ${this.byteOffset} in ${name} in ${scope.name}`);
        }

        if (v < 0n || v >= 256) {
            throw new EncodingError(`Value ${v} is not a byte`);
        }

        word[this.byteOffset] = Number(v);
    }
}

export class PointerLocalView
    extends BaseLocalView<View, PointerType>
    implements PointerView<null, View<any, Value, any, BaseRuntimeType>>
{
    toView(): DecodingFailure | View<any, Value, any, BaseRuntimeType> {
        const ptr = this.decode();

        if (isFailure(ptr)) {
            return ptr;
        }

        return ptr;
    }
}

export class ArrayLikeLocalView
    extends BaseLocalView<Uint8Array, FixedBytesType>
    implements ArrayLikeView<any, SingleByteLocalView>
{
    size(): bigint {
        return BigInt(this.type.numBytes);
    }

    indexView(key: bigint): DecodingFailure | SingleByteLocalView {
        if (key < 0n || key > this.type.numBytes) {
            return new DecodingFailure(`OoB access`);
        }

        return new SingleByteLocalView(this.loc, Number(key));
    }
}

export function isPointerView(v: any): v is PointerView<any, View> {
    return v instanceof PointerLocalView || baseIsPointerView(v);
}

export function isArrayLikeView(v: any): v is ArrayLikeView<any, View> {
    return (
        isArrayLikeMemView(v) ||
        isArrayLikeCalldataView(v) ||
        isArrayLikeStorageView(v) ||
        v instanceof ArrayLikeLocalView
    );
}
