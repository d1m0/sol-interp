import { Command } from "commander";
import { getTXReplayInfo } from "./quicknode";
import { getArtifacts } from "./etherscan";
import { ContractInfo, PartialSolcOutput } from "sol-dbg";
import { replayEVM } from "../alignment/evm_trace";
import { AlignedTraceBuilder, makeSolMessage } from "../alignment";
import { ArtifactManager } from "../interp/artifactManager";
import { hasMisaligned } from "../alignment";
import { getExecutedAddresses, tracerStorageToStorageDump } from "./utils";
import { AccountMap } from "../interp";
import * as fse from "fs-extra";
import { join, normalize } from "path";

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

(async () => {
    const program = new Command();

    program
        .name("sol-replay")
        .description("Replay a mainnet TX fetching source info from etherscan")
        .helpOption("-h, --help", "Print help message.");

    program.argument("tx", "Mainnet TX.");

    program.requiredOption("-q --quicknode-endpoint <quicknode>", "Quicknode Endpoint");
    program.requiredOption("-e --etherscan-key <etherscan-api-key>", "Etherscan api key");
    program.requiredOption(
        "-d --dump-sources <dir>",
        "Dump the sources for any contracts in the given directory."
    );
    program.option("--max-num-steps <max-num-steps>", "Maximum Number of steps", "1000000000");

    program.parse(process.argv);
    const [txHash] = program.args;
    const opts = program.opts();

    console.error(`Fetching ${txHash} from quicknode:`);
    const txReplayInfo = await getTXReplayInfo(opts.quicknodeEndpoint, txHash);

    const [trace, , , block, evmTx] = await replayEVM(
        txReplayInfo.preState,
        txReplayInfo.tx,
        txReplayInfo.block,
        txReplayInfo.sender
    );

    const addrsTouched = getExecutedAddresses(trace);
    const addrToContract = await getArtifacts(addrsTouched, opts.etherscanKey);
    const artifacts: PartialSolcOutput[] = [...addrToContract.values()].map((p) => p[0]);
    const artifactManager = new ArtifactManager(artifacts);

    const interpPreState = tracerStorageToStorageDump(txReplayInfo.preState);
    addArtifactToAccountMap(interpPreState, artifactManager, addrToContract);

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
                const filePath = join(addrBase, normalize(file));
                fse.writeFileSync(filePath, source.contents);
            }
        }
    }

    const builder = new AlignedTraceBuilder(
        artifactManager,
        interpPreState,
        trace,
        makeSolMessage(evmTx),
        block,
        Number(opts.maxNumSteps)
    );

    const [alignedTraces] = builder.buildAlignedTraces();
    console.error(`Has misalignment: `, hasMisaligned(alignedTraces));
})();
