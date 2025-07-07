import { nyi, ZERO_ADDRESS } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { Value } from "./value";

export function makeZeroValue(t: sol.TypeNode): Value {
    if (t instanceof sol.IntType) {
        return 0n;
    }

    if (t instanceof sol.BoolType) {
        return false;
    }

    if (t instanceof sol.FixedBytesType) {
        return new Uint8Array(t.size);
    }

    if (t instanceof sol.AddressType) {
        return ZERO_ADDRESS;
    }

    nyi(`makeZeroValue(${t.pp()})`);
}
