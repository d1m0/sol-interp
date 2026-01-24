import * as sol from "solc-typed-ast";
/**
 * @todo: This is a very inefficient and ugly way of doing bit shifts. Just works for now. Should fix this
 */

/**
 * Set the N-th bit of a Uint8Array (counted from left to right)
 */
function setBit(x: Uint8Array, idx: number, val: number): void {
    const byteIdx = x.length - 1 - Math.floor(idx / 8);
    const bitIdx = idx % 8;
    if (val == 0) {
        x[byteIdx] &= 255 - (1 << bitIdx);
    } else {
        x[byteIdx] |= 1 << bitIdx;
    }
}

function getBit(x: Uint8Array, idx: number): number {
    const byteIdx = x.length - 1 - Math.floor(idx / 8);
    const bitIdx = idx % 8;

    return (x[byteIdx] & (1 << bitIdx)) == 0 ? 0 : 1;
}

/**
 * Implement bshl on a Uint8Array.
 */
export function bshl(x: Uint8Array, y: bigint): Uint8Array {
    sol.assert(y >= 0, `Solidity doesnt support shifts by a negative value`);
    const res = new Uint8Array(x.length);
    const bitLen = x.length * 8;

    if (y >= bitLen) {
        return res;
    }

    const yNum = Number(y);

    for (let i = yNum; i <= bitLen; i++) {
        setBit(res, i, getBit(x, i - yNum));
    }

    return res;
}

/**
 * Implement bshr on a Uint8Array.
 */
export function bshr(x: Uint8Array, y: bigint): Uint8Array {
    sol.assert(y >= 0, `Solidity doesnt support shifts by a negative value`);
    const res = new Uint8Array(x.length);
    const bitLen = x.length * 8;

    if (y >= bitLen) {
        return res;
    }

    const yNum = Number(y);

    for (let i = 0; i < bitLen - 1 - yNum; i++) {
        setBit(res, i, getBit(x, i + yNum));
    }

    return res;
}

export function xor(x: Uint8Array, y: Uint8Array): Uint8Array {
    sol.assert(x.length == y.length, ``);
    const res = new Uint8Array(x.length);
    for (let i = 0; i < x.length; i++) {
        res[i] = x[i] ^ y[i];
    }

    return res;
}
