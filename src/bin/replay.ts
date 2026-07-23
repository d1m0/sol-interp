import { Command } from "commander";
import { getBlockReplayInfo, getTXReplayInfo, record, getArtifact, dump } from "../services";
import { replayMainnetTX } from "../services/replay";
import { sleep } from "./utils";
import { exit } from "process";

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
        "-a, --artifacts <addrs...>",
        "A list of addresses for which to try and re-build the artifacts."
    );

    program.option(
        "-d, --dump-sources <dir>",
        "Dump the sources for any contracts in the given directory."
    );
    program.option("--max-num-steps <max-num-steps>", "Maximum Number of steps", "1000000000");
    program.option("--add-state", "Wether to add the full state to the interpreter trace", false);
    program.option("--stats <stats-file>", "Path to a file in which to dump stats");

    program.parse(process.argv);
    const opts = program.opts();

    if (opts.txHashes) {
        for (const hash of opts.txHashes) {
            try {
                const info = await getTXReplayInfo(opts.quicknodeEndpoint, hash);
                await replayMainnetTX(
                    info,
                    opts.quicknodeEndpoint,
                    opts.etherscanKey,
                    opts.addState,
                    Number(opts.maxNumSteps),
                    opts.dumpSources
                );
            } catch (e) {
                record(`${(e as any).constructor.name}:${(e as any).message}`, hash);
            }
        }
    }

    // Txs that currently cause OoM
    const skipSet = new Set<string>([
        "0x3bc7756d3ae0367c774a9eec7e65c388cecf691c066e763c4d88f5f64a47bcb9",
        "0x386769acb1f7e97a6780de6b82067db6e4f610fab86101aa6a1a9a71d5eb2ba5",
        "0xa2266d846b719240d7076384afcd8dc506142d96de62daa358a73f1bf7abeab7",
        "0x6f6933c5ca98b58813fe7f9eff228261025bd1fa6d5d0ab580c74c48211f0346",
        "0xcf6262778407859c2f1359147b91c47c9f6d4f36ffd85cf13bc3a362e8cbc556"
    ]);

    if (opts.blockNums) {
        for (const blockNum of opts.blockNums) {
            try {
                for (const txReplayInfo of await getBlockReplayInfo(
                    opts.quicknodeEndpoint,
                    Number(blockNum)
                )) {
                    if (skipSet.has(txReplayInfo.txHash)) {
                        console.error(`Skipping ${txReplayInfo.txHash}`);
                        continue;
                    }
                    try {
                        const [, alignedTrace] = await replayMainnetTX(
                            txReplayInfo,
                            opts.quicknodeEndpoint,
                            opts.etherscanKey,
                            opts.addState,
                            Number(opts.maxNumSteps),
                            opts.dumpSources
                        );

                        for (const p of alignedTrace) {
                            record(`segment:${p.type}`, null, false);
                        }
                    } catch (e) {
                        record(
                            `${(e as any).constructor.name}:${(e as any).message}`,
                            txReplayInfo.txHash
                        );
                    }
                }
            } catch (e) {
                console.error(`Error getting block ${blockNum}: ${e}`);
                await sleep(10000);
            }
        }
    }

    if (opts.artifacts) {
        for (const addr of opts.artifacts) {
            try {
                await getArtifact(addr, opts.etherscanKey, opts.quicknodeEndpoint);
            } catch (e) {
                console.error(e);
                exit(-1);
            }
        }
    }

    dump(opts.stats ? opts.stats : "-");
})();
