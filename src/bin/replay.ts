import { Command } from "commander";
import { getBlockReplayInfo, getTXReplayInfo, dump, record } from "../services";
import { replayMainnetTX } from "../services/replay";
import { sleep } from "./utils";

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
    program.option("--add-state", "Wether to add the state or not", false);
    program.option("--stats <stats-file>", "Path to a file in which to dump stats");

    program.parse(process.argv);
    const opts = program.opts();

    if (opts.txHashes) {
        for (const hash of opts.txHashes) {
            const info = await getTXReplayInfo(opts.quicknodeEndpoint, hash);
            await replayMainnetTX(
                info,
                opts.quicknodeEndpoint,
                opts.etherscanKey,
                opts.addState,
                Number(opts.maxNumSteps),
                opts.dumpSources
            );
        }
    }

    const allTouchedAddrs = new Set<string>();
    if (opts.blockNums) {
        for (const blockNum of opts.blockNums) {
            try {
                for (const txReplayInfo of await getBlockReplayInfo(
                    opts.quicknodeEndpoint,
                    Number(blockNum)
                )) {
                    if (
                        txReplayInfo.txHash ===
                        "0x3bc7756d3ae0367c774a9eec7e65c388cecf691c066e763c4d88f5f64a47bcb9"
                    ) {
                        console.error(`Skipping ${txReplayInfo.txHash}`);
                        continue;
                    }
                    try {
                        const [, alignedTrace, addrToInfoM] = await replayMainnetTX(
                            txReplayInfo,
                            opts.quicknodeEndpoint,
                            opts.etherscanKey,
                            opts.addState,
                            Number(opts.maxNumSteps),
                            opts.dumpSources
                        );

                        for (const addr in addrToInfoM) {
                            allTouchedAddrs.add(addr);
                        }

                        for (const p of alignedTrace) {
                            record(`segment:${p.type}`, null, false);
                        }
                    } catch (e) {
                        record(`${(e as any).constructor.name}:${(e as any).message}`, [
                            txReplayInfo.blockHash,
                            txReplayInfo.txHash
                        ]);
                    }
                }
            } catch (e) {
                console.error(`Error getting block ${blockNum}: ${e}`);
                await sleep(10000);
            }
        }
    }

    console.error(`${allTouchedAddrs.size} addrs touched total.`);
    dump(opts.stats ? opts.stats : "-");
})();
