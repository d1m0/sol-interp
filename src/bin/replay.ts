import { Command } from "commander";
import { getTXReplayInfo } from "./quicknode";
import { getArtifact } from "./etherscan";
import { ContractInfo, PartialSolcOutput } from "sol-dbg";
import { replayEVM } from "../alignment/evm_trace";
import { AlignedTraceBuilder, makeSolMessage } from "../alignment";
import { ArtifactManager } from "../interp/artifactManager";
import { hasUnmached } from "../alignment/trace_builder";
import { assert } from "../utils"

(async () => {
    const program = new Command();

    program
        .name("sol-replay")
        .description("Replay a mainnet TX fetching source info from etherscan")
        .helpOption("-h, --help", "Print help message.");

    program.argument("tx", "Mainnet TX.");

    program.requiredOption("-q --quicknode-endpoint <quicknode>", "Quicknode Endpoint");
    program.requiredOption("-e --etherscan-key <etherscan-api-key>", "Etherscan api key");
    program.option("--max-num-steps <max-num-steps>", "Maximum Number of steps", "1000000000");

    program.parse(process.argv);
    const [txHash] = program.args;
    const opts = program.opts();

    console.error(`Fetching ${txHash} from quicknode:`);
    const txReplayInfo = await getTXReplayInfo(opts.quicknodeEndpoint, txHash);


    const [trace, , , evmTx] = await replayEVM(txReplayInfo.preState, txReplayInfo.tx, txReplayInfo.block, txReplayInfo.sender)

    const addrsTouched = new Set<string>();
    for (const step of trace) {
        addrsTouched.add(step.address.toString());
        if (step.codeAddress !== undefined) {
            addrsTouched.add(step.codeAddress.toString());
        }
    }
    const artifacts: PartialSolcOutput[] = [];

    const addrToMainContract = new Map<string, [string, string]>()

    for (const addr of addrsTouched) {
        console.error(`Try fetching source for ${addr}:`);
        const artifactDesc = await getArtifact(addr, opts.etherscanKey);
        if (artifactDesc !== undefined) {
            const [artifact, fileName, contractName] = artifactDesc

            artifacts.push(artifact);
            addrToMainContract.set(addr, [fileName, contractName]);
            assert(fileName in artifact.contracts && contractName in artifact.contracts[fileName], `Missing info for main contract {0}:{1}`, fileName, contractName)
        }
    }

    const artifactManager = new ArtifactManager(artifacts);

    const nameToArtifact = new Map<string, ContractInfo>();
    for (const info of artifactManager.contracts()) {
        nameToArtifact.set(`${info.fileName}:${info.contractName}`, info)
    }

    // Add contract info to initial state
    for (const [, accountInfo] of txReplayInfo.preState.entries()) {
        const t = addrToMainContract.get(accountInfo.address.toString())

        if (t) {
            const [fileName, contractName] = t;
            const info = nameToArtifact.get(`${fileName}:${contractName}`)

            if (info) {
                accountInfo.contract = info;
            }
        }
    }

    const builder = new AlignedTraceBuilder(
        artifactManager,
        txReplayInfo.preState,
        trace,
        makeSolMessage(evmTx, txReplayInfo.sender),
        Number(opts.maxNumSteps)
    );

    const [alignedTraces,] = builder.buildAlignedTraces();
    console.error(`Has misalignment: `, hasUnmached(alignedTraces));
})();
