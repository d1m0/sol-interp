import { Command } from "commander";
import {
    getBlockReplayInfo,
    getTXReplayInfo,
    QuicknodeBlockManager,
    ReplayInfo
} from "./quicknode";
import { getArtifacts } from "./etherscan";
import { ContractInfo, PartialSolcOutput } from "sol-dbg";
import { replayEVM } from "../alignment/evm_trace";
import { AlignedTraceBuilder, alignedTraceWellFormed, makeSolMessage } from "../alignment";
import { ArtifactManager } from "../interp/artifactManager";
import { hasMisaligned } from "../alignment";
import { getExecutedAddresses, tracerStorageToStorageDump } from "./utils";
import { AccountMap, FixedSetBlockManager } from "../interp";
import * as fse from "fs-extra";
import { basename, dirname, join, normalize } from "path";
import { dump, record } from "./stats";

/**
 * Given a map from addresses to contract identifiers of the form `fileName:contractName` and an AccountMap `state`
 * for each address, lookup its contract in the given `ArtifactManager`, and if a contract is found, add its info to the relevant
 * `AccountInfo` in `state`.
 */
function addArtifactToAccountMap(
    state: AccountMap,
    artifactManager: ArtifactManager,
    addrToNameMap: Map<string, [PartialSolcOutput, string]>
): void {
    const nameToArtifact = new Map<string, ContractInfo>();
    for (const info of artifactManager.contracts()) {
        nameToArtifact.set(`${info.fileName}:${info.contractName}`, info);
    }

    // Add contract info to initial state
    for (const [, accountInfo] of state.entries()) {
        const t = addrToNameMap.get(accountInfo.address.toString());

        if (t) {
            const info = nameToArtifact.get(t[1]);

            if (info) {
                accountInfo.contract = info;
            }
        }
    }
}

async function replayTX(txReplayInfo: ReplayInfo, opts: any): Promise<void> {
    try {
        console.error(`Replay TX ${txReplayInfo.txHash} in block ${txReplayInfo.blockHash}.`);
        record(`trace`, [txReplayInfo.blockHash, txReplayInfo.txHash]);

        const blockManager = new QuicknodeBlockManager(opts.quicknodeEndpoint);

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
        const addrToContract = await getArtifacts(addrsTouched, opts.etherscanKey);

        if (opts.dumpSources) {
            const srcBase = opts.dumpSources;
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

        const artifacts: PartialSolcOutput[] = [...addrToContract.values()].map((p) => p[0]);
        const artifactManager = new ArtifactManager(artifacts);

        const interpPreState = tracerStorageToStorageDump(txReplayInfo.preState);
        addArtifactToAccountMap(interpPreState, artifactManager, addrToContract);

        const prevBlocks = blockManager.getCachedBlocks();

        const builder = new AlignedTraceBuilder(
            artifactManager,
            interpPreState,
            trace,
            makeSolMessage(evmTx),
            block,
            evmTx,
            new FixedSetBlockManager([...prevBlocks, block]),
            Number(opts.maxNumSteps)
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
        const wellFormed = alignedTraceWellFormed(
            alignedTraces,
            trace,
            artifactManager,
            addrToInfoMap
        );

        if (!wellFormed) {
            record(`mallformed`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
            console.error(`Trace MALFORMED!`);
        } else if (hasMisaligned(alignedTraces)) {
            record(`misalignment`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
            console.error(`Has misalignment: `, hasMisaligned(alignedTraces));
        } else {
            record(`aligned`, [txReplayInfo.blockHash, txReplayInfo.txHash]);
        }
    } catch (e) {
        record(`${(e as any).constructor.name}:${(e as any).message}`, [
            txReplayInfo.blockHash,
            txReplayInfo.txHash
        ]);
    }
}

(async () => {
    const program = new Command();

    program
        .name("sol-replay")
        .description("Replay a mainnet TX fetching source info from etherscan")
        .helpOption("-h, --help", "Print help message.");

    program.option("-q, --quicknode-endpoint <quicknode>", "Quicknode Endpoint");
    program.option("-e, --etherscan-key <etherscan-api-key>", "Etherscan api key");

    program.option("-t, --tx-hashes <hashes...>", "A list of hashes of Mainnet TXs to replay.");
    program.option("-b, --block-nums <nums...>", "A list of numbers of Mainnet Blocks to replay.");

    program.option(
        "-d, --dump-sources <dir>",
        "Dump the sources for any contracts in the given directory."
    );
    program.option("--max-num-steps <max-num-steps>", "Maximum Number of steps", "1000000000");
    program.option("--stats <stats-file>", "Path to a file in which to dump stats");

    program.parse(process.argv);
    const opts = program.opts();

    if (opts.txHashes) {
        for (const hash of opts.txHashes) {
            await replayTX(await getTXReplayInfo(opts.quicknodeEndpoint, hash), opts);
        }
    }

    if (opts.blockNums) {
        for (const blockNum of opts.blockNums) {
            for (const txReplayInfo of await getBlockReplayInfo(
                opts.quicknodeEndpoint,
                Number(blockNum)
            )) {
                await replayTX(txReplayInfo, opts);
            }
        }
    }

    dump(opts.stats ? opts.stats : "-");
})();
