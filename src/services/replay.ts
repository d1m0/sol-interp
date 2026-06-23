import {
    QuicknodeBlockManager,
    ReplayInfo,
    getArtifacts,
    record,
    recordDistr,
    CompiledArtifact,
    getCode,
    isProxy
} from "../services";
import { ArtifactInfo, ContractInfo, ImmMap, zip3, bigEndianBufToBigint, zip } from "sol-dbg";
import { EVMStep, replayEVM } from "../alignment/evm_trace";
import {
    AlignedTraceBuilder,
    AlignedTraces,
    alignedTraceWellFormed,
    isAllNoSource,
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
import { createAddressFromString, hexToBigInt } from "@ethereumjs/util";

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
    addState: boolean,
    maxNumSteps: number,
    srcDumpDir?: string
): Promise<[ArtifactManager, AlignedTraces, Map<string, [ArtifactInfo, string]>]> {
    console.error(
        `Replay TX ${txReplayInfo.txHash} in block ${hexToBigInt((txReplayInfo.block.header as any).number)}.`
    );
    record(`trace`, [txReplayInfo.blockHash, txReplayInfo.txHash]);

    const blockManager = new QuicknodeBlockManager(quicknodeEndpoint);

    const startReplay = Date.now();
    const [trace, , , block, evmTx] = await replayEVM(
        txReplayInfo.preState,
        txReplayInfo.tx,
        txReplayInfo.block,
        blockManager,
        txReplayInfo.sender
    );

    const replayDone = Date.now();

    recordDistr("trace_len", trace.length, txReplayInfo.txHash);
    if (trace.length > 0) {
        record(`trace_non_zero`, txReplayInfo.txHash);
        recordDistr("trace_non_zero_len", trace.length, txReplayInfo.txHash);
        recordDistr(`duration_evm_replay_done`, replayDone - startReplay, txReplayInfo.txHash);
    }

    const addrsTouched = getExecutedAddresses(trace);
    const nonProxyAddrsTouched: string[] = [];

    for (const addr of addrsTouched) {
        const code = await getCode(quicknodeEndpoint, addr, Number(block.header.number));
        if (isProxy(code)) {
            continue;
        }

        nonProxyAddrsTouched.push(addr);
    }

    const addrToContract = await getArtifacts(
        nonProxyAddrsTouched,
        etherscanKey,
        quicknodeEndpoint
    );

    if (srcDumpDir !== undefined) {
        const srcBase = srcDumpDir;
        fse.mkdirpSync(srcBase);
        for (const [addr, artifact] of addrToContract.entries()) {
            const addrBase = join(srcBase, addr);
            fse.mkdirpSync(addrBase);
            for (const [file, source] of Object.entries(artifact.artifact.sources)) {
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

    const addrsAndCompiledArtifacts: Array<[string, CompiledArtifact]> = [
        ...addrToContract.entries()
    ];
    const artifactManager = new ArtifactManager(
        addrsAndCompiledArtifacts.map((p) => p[1].artifact)
    );

    for (const [artifactInfo, addrAndArtifact] of zip(
        artifactManager.artifacts(),
        addrsAndCompiledArtifacts
    )) {
        const artifact = addrAndArtifact[1];
        if (!(artifact.input && artifact.input.settings)) {
            continue;
        }

        artifactInfo.codegen =
            "viaIR" in artifact.input.settings && artifact.input.settings.viaIR ? "ir" : "old";

        if (!(artifact.input && artifact.input.settings && artifact.input.settings.libraries)) {
            continue;
        }

        for (const contractId in artifact.input.settings.libraries) {
            let libToAddrM = artifactInfo.linkedLibraries.get(contractId);

            if (libToAddrM === undefined) {
                libToAddrM = new Map();
                artifactInfo.linkedLibraries.set(contractId, libToAddrM);
            }

            for (const libraryName in artifact.input.settings.libraries[contractId]) {
                libToAddrM.set(
                    libraryName,
                    createAddressFromString(
                        artifact.input.settings.libraries[contractId][libraryName]
                    )
                );
            }
        }
    }

    const addrsArtifactInfoAndMainContractId = zip3(
        addrsAndCompiledArtifacts.map((k) => k[0]),
        artifactManager.artifacts(),
        addrsAndCompiledArtifacts.map((k) => `${k[1].fileName}:${k[1].contractName}`)
    );
    const addrToArtifactAndContractId = new Map<string, [ArtifactInfo, string]>(
        addrsArtifactInfoAndMainContractId.map(([addr, info, id]) => [addr, [info, id]])
    );

    const interpPreState = tracerStorageToStorageDump(txReplayInfo.preState);
    addArtifactToAccountMap(interpPreState, addrToArtifactAndContractId);

    const prevBlocks = blockManager.getCachedBlocks();

    const prepAlignmentData = Date.now();
    recordDistr(`duration_fetch_data`, prepAlignmentData - replayDone, txReplayInfo.txHash);
    const builder = new AlignedTraceBuilder(
        artifactManager,
        interpPreState,
        trace,
        makeSolMessage(evmTx),
        block,
        evmTx,
        new FixedSetBlockManager([...prevBlocks, block]),
        addState,
        Number(maxNumSteps)
    );

    const [alignedTraces] = builder.buildAlignedTraces();

    const alignedDone = Date.now();
    recordDistr(`duration_alignment`, alignedDone - prepAlignmentData, txReplayInfo.txHash);
    recordDistr(`duration_replay`, alignedDone - startReplay, txReplayInfo.txHash);

    const addrToInfoMap = new Map<string, ContractInfo>(
        [...addrToContract.entries()].map(([strAddr, artifact]) => [
            strAddr,
            artifactManager
                .contracts()
                .filter(
                    (ci) =>
                        `${artifact.fileName}:${artifact.contractName}` ===
                        `${ci.fileName}:${ci.contractName}`
                )[0]
        ])
    );

    const wellFormed = alignedTraceWellFormed(alignedTraces, trace, artifactManager, addrToInfoMap);

    recordDistr("num_segments", alignedTraces.length, txReplayInfo.txHash);

    if (!wellFormed) {
        record(`mallformed`, txReplayInfo.txHash);
    } else {
        if (trace.length > 0) {
            if (isAllNoSource(alignedTraces)) {
                record(`non_zero_no_source`, txReplayInfo.txHash);
            } else {
                if (!hasMisaligned(alignedTraces)) {
                    record(`non_zero_w_source_aligned`, txReplayInfo.txHash);
                } else {
                    if (hasMisaligned(alignedTraces, "misaligned:low_level_exception")) {
                        record(`non_zero_w_source_out_of_gas`, txReplayInfo.txHash);
                    }

                    if (hasMisaligned(alignedTraces, "misaligned:inline_asm")) {
                        record(`non_zero_w_source_inline_asm`, txReplayInfo.txHash);
                    }

                    if (hasMisaligned(alignedTraces, "misaligned:error")) {
                        record(`non_zero_w_source_error`, txReplayInfo.txHash);
                    }
                }
            }
        }
    }

    return [artifactManager, alignedTraces, addrToArtifactAndContractId];
}
