import * as sol from "solc-typed-ast";
import { Value } from "./value";
import { ExpStructType, fits, nyi, View } from "sol-dbg";
import { ppValue } from "./pp";
import { Address } from "@ethereumjs/util";
import { isArrayLikeView } from "./view";
import { isStructView } from "./utils";
import { TOptional } from "./polymorphic";

export function valueIsOfType(v: Value, t: sol.TypeNode): boolean {
    if (t instanceof sol.IntLiteralType) {
        return typeof v === "bigint";
    }

    if (t instanceof sol.IntType) {
        return typeof v === "bigint" && fits(v, t);
    }

    if (t instanceof sol.FixedBytesType) {
        return v instanceof Uint8Array && v.length === t.size;
    }

    if (t instanceof sol.AddressType) {
        return v instanceof Address;
    }

    if (t instanceof sol.BoolType) {
        return typeof v === "boolean";
    }

    if (t instanceof sol.ArrayType) {
        // @todo check size on statically sized arrays
        return isArrayLikeView(v);
    }

    if (t instanceof ExpStructType) {
        return isStructView(v);
    }

    if (t instanceof sol.PointerType) {
        return v instanceof View && valueIsOfType(v, t.to);
    }

    if (t instanceof TOptional) {
        return valueIsOfType(v, t.subT);
    }

    if (t instanceof sol.TupleType) {
        if (!(v instanceof Array)) {
            return false;
        }

        if (v.length > t.elements.length) {
            return false;
        }

        for (let i = 0; i < v.length; i++) {
            const elT = t.elements[i];
            sol.assert(elT !== null, ``);
            if (!valueIsOfType(v[i], elT)) {
                return false;
            }
        }

        for (let i = v.length; i < t.elements.length; i++) {
            if (!(t.elements[i] instanceof TOptional)) {
                return false;
            }
        }

        return true;
    }

    nyi(`valueIsOfType(${ppValue(v)}, ${t.pp()})`);
}
