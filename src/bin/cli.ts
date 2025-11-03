import { Command } from "commander";
import * as sol from "solc-typed-ast"
const { version } = require("../../package.json");
import * as fse from "fs-extra"
import { PartialSolcOutput } from "sol-dbg";
import { ArtifactManager } from "../interp/artifactManager";
import { Runner } from "./runner";
import { parseStep, SyntaxError } from "./ast";

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

function error(message: string): never {
    terminate(message, 1);
}

(async () => {
    const program = new Command();

    program
        .name("sol-interp")
        .description("Execute a sequence of steps given some solidity files")
        .version(version, "-v, --version", "Print package version.")
        .helpOption("-h, --help", "Print help message.");

    program.argument(
        "[file(s)]",
        "Either one or more Solidity files, or JSON compiler output files."
    );

    program
        .option("--steps [step...]", "Steps to execute")

    program.parse(process.argv);
    const args = program.args;
    const options = program.opts();

    if (args.length === 0) {
        error("Need at least one file")
    }

    const artifacts: PartialSolcOutput[] = []

    try {
        for (const file of args) {
            if (file.endsWith("sol")) {
                const { data } = await sol.compileSol(file, "auto");
                artifacts.push(data);
            } else {
                const data = fse.readJSONSync(file)
                artifacts.push(data)
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

    const artifactManager = new ArtifactManager(artifacts)
    const runner = new Runner(artifactManager);

    for (const step of options.steps) {
        try {
            const parsedStep = parseStep(step);
            const res = runner.run(parsedStep);
            console.error(res)
        } catch (e) {
            if (e instanceof SyntaxError) {
                error(`SyntaxError ${e.location}: ${e.message}`);
            }

            throw (e)
        }
    }
})();