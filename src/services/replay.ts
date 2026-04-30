import {
    getCode,
    QuicknodeBlockManager,
    ReplayInfo,
    getArtifacts,
    tryMatchERC1167,
    record
} from "../services";
import {
    ArtifactInfo,
    ContractInfo,
    ImmMap,
    PartialSolcOutput,
    zip3,
    bigEndianBufToBigint
} from "sol-dbg";
import { EVMStep, replayEVM } from "../alignment/evm_trace";
import {
    AlignedTraceBuilder,
    AlignedTraces,
    alignedTraceWellFormed,
    makeSolMessage
} from "../alignment";
import { ArtifactManager } from "../interp/artifactManager";
import { hasMisaligned } from "../alignment";
import { AccountMap, FixedSetBlockManager } from "../interp";
import * as fse from "fs-extra";
import { basename, dirname, join, normalize } from "path";
import { assert } from "../utils";
import { keccak256 } from "ethereum-cryptography/keccak";
import { bigIntToBuf, Storage } from "sol-dbg";

/**
 * Given a map from addresses to contract identifiers of the form `fileName:contractName` and an AccountMap `state`
 * for each address, lookup its contract in the given `ArtifactManager`, and if a contract is found, add its info to the relevant
 * `AccountInfo` in `state`.
 */
function addArtifactToAccountMap(
    state: AccountMap,
    addrToArtifact: Map<string, [ArtifactInfo, string]>
): void {
    // Add contract info to initial state
    for (const [, accountInfo] of state.entries()) {
        const t = addrToArtifact.get(accountInfo.address.toString());

        if (t) {
            const [artifactInfo, id] = t;
            const matchingContracts = artifactInfo.contracts.filter(
                (info) => id === `${info.fileName}:${info.contractName}`
            );

            assert(matchingContracts.length <= 1, `Unexpected multiple contracts with id ${id}`);
            if (matchingContracts.length === 1) {
                accountInfo.contract = matchingContracts[0];
                continue;
            }
            assert(false, `Shouldn't get here`);
        }
    }
}

function lowerStorage(s: Storage): Storage {
    return ImmMap.fromEntries(
        [...s.entries()].map(([key, val]) => [
            bigEndianBufToBigint(keccak256(bigIntToBuf(key, 32, "big"))),
            val
        ])
    );
}

export function tracerStorageToStorageDump(tStorage: AccountMap): AccountMap {
    return ImmMap.fromEntries(
        [...tStorage.entries()].map(([addr, accInfo]) => [
            addr,
            {
                ...accInfo,
                storage: lowerStorage(accInfo.storage)
            }
        ])
    );
}

/**
 * Return set of addresses that were executed during the trace. In the case of
 * delegate calls this includes both the delegated and delegating contracts.
 */
export function getExecutedAddresses(trace: EVMStep[]): Set<string> {
    const addrsTouched = new Set<string>();
    for (const step of trace) {
        addrsTouched.add(step.address.toString());
        if (step.codeAddress !== undefined) {
            addrsTouched.add(step.codeAddress.toString());
        }
    }
    return addrsTouched;
}

export async function replayMainnetTX(
    txReplayInfo: ReplayInfo,
    quicknodeEndpoint: string,
    etherscanKey: string,
    maxNumSteps: number,
    srcDumpDir?: string
): Promise<[ArtifactManager, AlignedTraces, Map<string, [ArtifactInfo, string]>]> {
    console.error(`Replay TX ${txReplayInfo.txHash} in block ${txReplayInfo.blockHash}.`);
    record(`trace`, [txReplayInfo.blockHash, txReplayInfo.txHash]);

    const blockManager = new QuicknodeBlockManager(quicknodeEndpoint);

    const [trace, , , block, evmTx] = await replayEVM(
        txReplayInfo.preState,
        txReplayInfo.tx,
        txReplayInfo.block,
        blockManager,
        txReplayInfo.sender
    );

    if (trace.length === 0) {
        record(`zero_length`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
    }

    const addrsTouched = getExecutedAddresses(trace);
    const nonProxyAddrsTouched: string[] = [];

    for (const addr of addrsTouched) {
        const code = await getCode(quicknodeEndpoint, addr, Number(block.header.number));
        if (tryMatchERC1167(code) !== undefined) {
            continue;
        }

        nonProxyAddrsTouched.push(addr);
    }

    const addrToContract = await getArtifacts(nonProxyAddrsTouched, etherscanKey);

    if (srcDumpDir !== undefined) {
        const srcBase = srcDumpDir;
        fse.mkdirpSync(srcBase);
        for (const [addr, [artifact]] of addrToContract.entries()) {
            const addrBase = join(srcBase, addr);
            fse.mkdirpSync(addrBase);
            for (const [file, source] of Object.entries(artifact.sources)) {
                if (source.contents === undefined) {
                    continue;
                }
                const dirPath = join(addrBase, normalize(dirname(file)));
                fse.mkdirpSync(dirPath);
                const baseName = basename(file);
                const filePath = join(dirPath, baseName);
                fse.writeFileSync(filePath, source.contents);
            }
        }
    }

    const addrsAndSolcJSONs: Array<[string, [PartialSolcOutput, string]]> = [
        ...addrToContract.entries()
    ];
    const artifactManager = new ArtifactManager(addrsAndSolcJSONs.map((p) => p[1][0]));
    const addrsArtifactInfoAndMainContractId = zip3(
        addrsAndSolcJSONs.map((k) => k[0]),
        artifactManager.artifacts(),
        addrsAndSolcJSONs.map((k) => k[1][1])
    );
    const addrToArtifactAndContractId = new Map<string, [ArtifactInfo, string]>(
        addrsArtifactInfoAndMainContractId.map(([addr, info, id]) => [addr, [info, id]])
    );

    const interpPreState = tracerStorageToStorageDump(txReplayInfo.preState);
    addArtifactToAccountMap(interpPreState, addrToArtifactAndContractId);

    const prevBlocks = blockManager.getCachedBlocks();

    const builder = new AlignedTraceBuilder(
        artifactManager,
        interpPreState,
        trace,
        makeSolMessage(evmTx),
        block,
        evmTx,
        new FixedSetBlockManager([...prevBlocks, block]),
        Number(maxNumSteps)
    );

    const [alignedTraces] = builder.buildAlignedTraces();

    const addrToInfoMap = new Map<string, ContractInfo>(
        [...addrToContract.entries()].map(([strAddr, [, contractId]]) => [
            strAddr,
            artifactManager
                .contracts()
                .filter((ci) => contractId === `${ci.fileName}:${ci.contractName}`)[0]
        ])
    );
    const wellFormed = alignedTraceWellFormed(alignedTraces, trace, artifactManager, addrToInfoMap);

    if (!wellFormed) {
        record(`mallformed`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
        console.error(`Trace MALFORMED!`);
    } else if (hasMisaligned(alignedTraces)) {
        record(`misalignment`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
        console.error(`Has misalignment: `, hasMisaligned(alignedTraces));
    } else {
        if (trace.length > 0) {
            record(`aligned_non_zero`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
        }
        record(`aligned`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
    }

    return [artifactManager, alignedTraces, addrToArtifactAndContractId];
}
