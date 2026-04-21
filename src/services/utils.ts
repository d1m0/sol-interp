import { bytesToUtf8 } from "@ethereumjs/util";
import { PartialSolcOutput } from "sol-dbg";
import * as sol from "solc-typed-ast"

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