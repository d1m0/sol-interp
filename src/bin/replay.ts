import { Command } from "commander";
import {
    getBlockReplayInfo,
    getTXReplayInfo,
    dump,
} from "../services";
import { replayMainnetTX } from "../services/replay";

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
            const info = await getTXReplayInfo(opts.quicknodeEndpoint, hash)
            await replayMainnetTX(info, opts.quicknodeEndpoint, opts.etherscanKey, opts.maxNumSteps, opts.dumpSources);
        }
    }

    if (opts.blockNums) {
        for (const blockNum of opts.blockNums) {
            for (const txReplayInfo of await getBlockReplayInfo(
                opts.quicknodeEndpoint,
                Number(blockNum)
            )) {
                await replayMainnetTX(txReplayInfo, opts.quicknodeEndpoint, opts.etherscanKey, opts.maxNumSteps, opts.dumpSources);
            }
        }
    }

    dump(opts.stats ? opts.stats : "-");
})();
