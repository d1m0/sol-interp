import * as ejs from "@ethereumjs/block";
import { Hardfork } from "@ethereumjs/common";
import { BigIntLike, bytesToBigInt } from "@ethereumjs/util";
import { getCommon, getCommonByBlockNum } from "sol-dbg";

function toBigInt(d: BigIntLike): bigint {
    if (d instanceof Uint8Array) {
        return bytesToBigInt(d);
    }

    return BigInt(d);
}

export function createBlock(data: ejs.BlockData, forcedHardfork?: Hardfork): ejs.Block {
    if (forcedHardfork) {
        return ejs.createBlock(data, { common: getCommon(forcedHardfork) });
    }

    const number =
        data.header !== undefined && data.header.number !== undefined
            ? toBigInt(data.header.number)
            : undefined;

    if (number) {
        return ejs.createBlock(data, { common: getCommonByBlockNum(number) });
    } else {
        return ejs.createBlock(data);
    }
}
