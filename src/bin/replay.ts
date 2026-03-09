import { Command } from "commander";
import { getTXReplayInfo } from "./quicknode";
/*
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { PartialSolcOutput, Value as BaseValue, Struct } from "sol-dbg";
import { Address, bytesToUtf8 } from "@ethereumjs/util";
import { CallResult } from "../interp";
*/

function terminate(message?: string, exitCode = 0): never {
    if (message !== undefined) {
        if (exitCode === 0) {
            console.log(message);
        } else {
            console.error(message);
        }
    }

    process.exit(exitCode);
}

export function error(message: string): never {
    terminate(message, 1);
}

(async () => {
    const program = new Command();

    program
        .name("sol-replay")
        .description("Replay a mainnet TX fetching source info from etherscan")
        .helpOption("-h, --help", "Print help message.");

    program.argument(
        "tx",
        "Mainnet TX."
    );

    program.requiredOption("-q --quicknode-endpoint <quicknode>", "Quicknode Endpoint")

    program.parse(process.argv);
    const [tx] = program.args;
    const opts = program.opts();


    console.error(`Fetching ${tx} from quicknode:`)
    const txReplayInfo = await getTXReplayInfo(opts.quicknodeEndpoint, tx)
    console.error(`Data: ${txReplayInfo}`)

    /*
    const artifacts: PartialSolcOutput[] = [];

    try {
        for (const file of args) {
            if (file.endsWith("sol")) {
                const { data, files } = await sol.compileSol(file, "auto");
                addSourcesToResult(data, files);
                artifacts.push(data);
            } else {
                const data = fse.readJSONSync(file);
                artifacts.push(data);
            }
        }
    } catch (e: any) {
        if (e instanceof sol.CompileFailedError) {
            console.error("Compile errors encountered:");

            for (const failure of e.failures) {
                console.error(
                    failure.compilerVersion
                        ? `SolcJS ${failure.compilerVersion}:`
                        : "Unknown compiler:"
                );

                for (const error of failure.errors) {
                    console.error(error);
                }
            }

            error("Unable to compile due to errors above.");
        }

        error(e.message);
    }

    const artifactManager = new ArtifactManager(artifacts);
    const runner = new Runner(artifactManager);

    for (const step of options.steps) {
        try {
            const parsedStep = parseStep(step);
            const oldTraceLen = runner.visitor.getTrace().length;
            try {
                const [res, returns] = runner.run(parsedStep);

                if (options.verbose) {
                    const newSegment = runner.visitor.getTrace().slice(oldTraceLen);
                    console.error(ppTrace(newSegment, artifactManager));
                }

                console.error(ppRes(res, returns));
            } catch (e) {
                if (options.verbose) {
                    const newSegment = runner.visitor.getTrace().slice(oldTraceLen);
                    console.error(ppTrace(newSegment, artifactManager));
                }

                throw e;
            }
        } catch (e) {
            if (e instanceof SyntaxError) {
                error(`SyntaxError ${e.location}: ${e.message}`);
            }

            throw e;
        }
    }
        */
})();
