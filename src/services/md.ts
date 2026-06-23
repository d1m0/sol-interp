import { hexToBytes } from "@ethereumjs/rlp";
import * as sol from "solc-typed-ast";
import { min, PartialCompiledContract, PartialSolcOutput, readInt16Be } from "sol-dbg";

type Interval = [number, number];
type IntervalList = Interval[];

export function diffBytes(a: Uint8Array, b: Uint8Array): IntervalList {
    const minLen = min(a.length, b.length);

    let startUneq: number | undefined = undefined;

    const res: IntervalList = [];

    for (let i = 0; i < minLen; i++) {
        if (a[i] !== b[i]) {
            if (startUneq === undefined) {
                startUneq = i;
            }
        } else {
            if (startUneq !== undefined) {
                res.push([startUneq, i]);
                startUneq = undefined;
            }
        }
    }

    const maxLen = a.length > b.length ? a.length : b.length;
    if (maxLen > minLen) {
        res.push([minLen, maxLen]);
    }

    return res;
}

/**
 * Build a list of the link and immutable ref ranges
 * @param contract
 */
function getExpectedDiffRanges(contract: PartialCompiledContract): IntervalList {
    const res: IntervalList = [];

    if (contract.evm.deployedBytecode.linkReferences !== undefined) {
        const linkRefs = contract.evm.deployedBytecode.linkReferences;
        for (const fileName in linkRefs) {
            for (const contractName in linkRefs[fileName]) {
                for (const rng of linkRefs[fileName][contractName]) {
                    res.push([rng.start, rng.start + rng.length]);
                }
            }
        }
    }

    if (contract.evm.deployedBytecode.immutableReferences) {
        const immRefs = contract.evm.deployedBytecode.immutableReferences;
        for (const id in immRefs) {
            for (const rng of immRefs[id]) {
                res.push([rng.start, rng.start + rng.length]);
            }
        }
    }

    return res;
}

/**
 * Returns true IFF `a` is contained in `b`. This includes exact overlap
 */
function contained(a: Interval, b: Interval): boolean {
    return a[0] >= b[0] && a[1] <= b[1];
}

import { Decoder } from "cbor";
import { bytesToHex } from "@ethereumjs/util";

function getMD(bytecode: Uint8Array, lenOff = bytecode.length - 2): [any, Interval] | undefined {
    try {
        const off = readInt16Be(bytecode, lenOff);

        const decoded = Decoder.decodeAllSync(bytecode.slice(lenOff - off, lenOff), {});

        if (!(decoded instanceof Array && decoded.length === 1)) {
            return undefined;
        }

        return [decoded[0], [lenOff - off, lenOff]];
    } catch {
        return undefined;
    }
}

const mdKeys = ["bzzr0", "bzzr1", "solc", "ipfs", "experimental"];
const mdHashKeys = new Set(["bzzr0", "bzzr1", "ipfs"]);
const mdKeysSet = new Set(mdKeys);
/**
 * Scan after the end of the interval, trying to decode a CBOR-encoded contract metadata struct, that contains this interval
 * @param int
 * @param bytecode
 */
function findMDContainingInterval(
    int: Interval,
    bytecode: Uint8Array
): [any, Interval] | undefined {
    for (let i = int[1]; i < bytecode.length; i++) {
        const t = getMD(bytecode, i);

        if (t === undefined) {
            continue;
        }

        const [md, mdInt] = t;

        // Check that metadata is an object that contains at least one of the expected fields,
        // and all of its fields are amongst the expected fields.
        // This guards against random CBOR decodes.
        if (
            !(
                md instanceof Object &&
                sol.forAny(mdKeys, (field) => field in md) &&
                sol.forAll(Object.keys(md), (key) => mdKeysSet.has(key))
            )
        ) {
            continue;
        }

        if (!contained(int, mdInt)) {
            return undefined;
        }

        return [md, mdInt];
    }

    return undefined;
}

export function makeMdHashMap(
    contract: PartialCompiledContract,
    onChainBytecode: Uint8Array
): Map<string, string> | undefined {
    const compiledBytecode = hexToBytes(`0x${contract.evm.deployedBytecode.object}`);
    if (onChainBytecode.length !== compiledBytecode.length) {
        return undefined;
    }

    const diffs = diffBytes(compiledBytecode, onChainBytecode);

    const expectedDiffs = getExpectedDiffRanges(contract);

    // Libraries start with an implicit `PUSH20 <address>`. This is not reflected in linkReferences or immutableReferences
    if (
        diffs.length > 0 &&
        diffs[0][0] === 1 &&
        diffs[0][1] === 21 &&
        contract.evm.deployedBytecode.object.startsWith(
            "730000000000000000000000000000000000000000"
        )
    ) {
        expectedDiffs.push([1, 21]);
    }

    const res = new Map<string, string>();

    for (const diffInt of diffs) {
        // Check if this diff falls within any of the expected differences (immutable and link references)
        const isExpected = sol.forAny(expectedDiffs, (expInt) => contained(diffInt, expInt));
        if (isExpected) {
            continue;
        }

        let t = findMDContainingInterval(diffInt, compiledBytecode);
        if (t === undefined) {
            return undefined;
        }

        const [compiledMd, compiledMdInt] = t;

        t = getMD(onChainBytecode, compiledMdInt[1]);

        if (t === undefined) {
            console.error(`Couldn't decode MD in the same offset in the on-chain bytecode`);
            return undefined;
        }

        const [onChainMd] = t;

        for (const field of Object.keys(compiledMd)) {
            const compField = compiledMd[field];
            const onChainField = onChainMd[field as any];

            if (field === "solc") {
                sol.assert(
                    compField instanceof Uint8Array && onChainField instanceof Uint8Array,
                    ``
                );

                if (bytesToHex(compField) !== bytesToHex(onChainField)) {
                    return undefined;
                }

                continue;
            }

            if (field === "experimental") {
                if (compField !== onChainField) {
                    return undefined;
                }

                continue;
            }

            // For non-hash keys we expect equality
            sol.assert(mdHashKeys.has(field), `Field must be a md hash`);
            sol.assert(
                compField instanceof Uint8Array &&
                    onChainField instanceof Uint8Array &&
                    compField.length === onChainField.length,
                ``
            );

            res.set(bytesToHex(compField).slice(2), bytesToHex(onChainField).slice(2));
        }
        expectedDiffs.push(compiledMdInt);
    }

    return res;
}

/**
 * Given a solc compilation `artifact`, the `fileName` and `contractName` of the main deployed contract, as well its actual `onChainBytecode`,
 * try to
 * 1) Detect any differences between the main contract's compiled bytecode and on-chain bytecode, that are due to differing metadata hashes
 * 2) Build a map from the local metadata hashes to the on-chain metadata hashes that appear in the main contract's bytecode. (The main contract's bytecode may contain other contract's bytecodes if it s deploying them)
 * 3) For *all* bytecodes in the artifact, replace all the metadata hashes according to the map from *2*
 * @param artifact
 * @param fileName
 * @param contractName
 * @param onChainBytecode
 */
export function fixArtifactBytecodes(
    artifact: PartialSolcOutput,
    fileName: string,
    contractName: string,
    onChainBytecode: Uint8Array
): boolean {
    const mainContract = artifact.contracts[fileName][contractName];
    const hashMap = makeMdHashMap(mainContract, onChainBytecode);

    if (hashMap === undefined) {
        return false;
    }

    for (const fileName in artifact.contracts) {
        for (const contractName in artifact.contracts[fileName]) {
            const contract = artifact.contracts[fileName][contractName];
            for (const bytecode of [contract.evm.bytecode, contract.evm.deployedBytecode]) {
                if (bytecode.object === "" || bytecode.object === "0x") {
                    continue;
                }

                for (const [fromHash, toHash] of hashMap) {
                    bytecode.object = bytecode.object.replaceAll(fromHash, toHash);
                }
            }
        }
    }

    return true;
}
