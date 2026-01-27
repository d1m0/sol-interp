import {
    PointerView,
    View,
    ArrayLikeView,
    isArrayLikeMemView,
    isArrayLikeCalldataView,
    isArrayLikeStorageView,
    isPointerView as baseIsPointerView
} from "sol-dbg";
import { PointerType } from "solc-typed-ast";
import { PointerLocalView, FixedBytesLocalView } from "./local";
import { TempView } from "./misc";

export function isPointerView(v: any): v is PointerView<any, View> {
    return (
        v instanceof PointerLocalView ||
        baseIsPointerView(v) ||
        (v instanceof TempView && v.type instanceof PointerType)
    );
}

export function isArrayLikeView(v: any): v is ArrayLikeView<any, View> {
    return (
        isArrayLikeMemView(v) ||
        isArrayLikeCalldataView(v) ||
        isArrayLikeStorageView(v) ||
        v instanceof FixedBytesLocalView
    );
}
