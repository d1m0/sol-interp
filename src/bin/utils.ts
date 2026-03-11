import { bytesToUtf8 } from "@ethereumjs/util";
import { PartialSolcOutput } from "sol-dbg";
import * as sol from "solc-typed-ast";

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

export function addSourcesToResult(artifact: PartialSolcOutput, files: sol.FileMap): void {
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
