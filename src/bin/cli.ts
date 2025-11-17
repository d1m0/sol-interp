import { Command } from "commander";
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { PartialSolcOutput, Value as BaseValue, Struct } from "sol-dbg";
import { ArtifactManager } from "../interp/artifactManager";
import { Runner } from "./runner";
import { parseStep, SyntaxError } from "./ast";
import { CallResult } from "../interp/state";
import { Address, bytesToUtf8 } from "@ethereumjs/util";
import { ppTrace } from "../interp/pp";

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

function ppBaseValue(v: BaseValue): string {
    if (v instanceof Address) {
        return v.toString();
    }

    if (v instanceof Array) {
        return "[" + v.map(ppBaseValue).join(", ") + "]";
    }

    if (v instanceof Struct) {
        return `{${v.entries.map(([name, val]) => `${name}: ${ppBaseValue(val)}`)}}`;
    }

    return sol.pp(v as unknown as any);
}

function ppRes(res: CallResult, decodedReturns: BaseValue[] | undefined): string {
    if (res.reverted) {
        return `reverted`;
    }

    if (decodedReturns) {
        return `return [${decodedReturns.map(ppBaseValue).join(", ")}]`;
    }

    return `succeeded`;
}

function addSourcesToResult(artifact: PartialSolcOutput, files: sol.FileMap): void {
    for (const name in artifact.sources) {
        if (artifact.sources[name].contents !== undefined) {
            continue;
        }

        const file = files.get(name);

        if (file) {
            artifact.sources[name].contents = bytesToUtf8(file);
        }
    }
}

(async () => {
    const program = new Command();

    program
        .name("sol-interp")
        .description("Execute a sequence of steps given some solidity files")
        .helpOption("-h, --help", "Print help message.");

    program.argument(
        "[file(s)]",
        "Either one or more Solidity files, or JSON compiler output files."
    );

    program.option("--steps [step...]", "Steps to execute");
    program.option("-v --verbose", "Verbose");

    program.parse(process.argv);
    const args = program.args;
    const options = program.opts();

    if (args.length === 0) {
        error("Need at least one file");
    }

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
})();
