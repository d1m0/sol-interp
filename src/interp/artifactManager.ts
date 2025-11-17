import {
    ArtifactInfo,
    ArtifactManager as BaseArtifactManager,
    BaseMemoryView,
    Memory,
    Value,
    BaseRuntimeType,
    PartialSolcOutput
} from "sol-dbg";
import { gatherConstants } from "./constants";
import * as sol from "solc-typed-ast";
import { bytesToUtf8 } from "@ethereumjs/util";

const srcLoc = require("src-location");

export type ConstantsMap = Map<number, BaseMemoryView<Value, BaseRuntimeType>>;
export type ConstantsInfo = [ConstantsMap, Memory];
export type FileLoc = [number, number]; // [line number, column number]

/**
 * Temporary hack
 * @todo remove after https://github.com/d1m0/sol-interp/issues/14 is fixed
 */
export function addSources(
    compilerOutput: PartialSolcOutput,
    fileMap: sol.FileMap
): PartialSolcOutput {
    for (const fileName in compilerOutput.sources) {
        const fileContents = fileMap.get(fileName);
        if (fileContents === undefined) {
            continue;
        }

        compilerOutput.sources[fileName].contents = bytesToUtf8(fileContents);
    }

    return compilerOutput;
}

export class ArtifactManager extends BaseArtifactManager {
    _constantsCache: Map<ArtifactInfo, ConstantsInfo> = new Map();

    getStartLoc(n: sol.ASTNode): FileLoc {
        const artifact = this.getArtifact(n);
        const [start, , fileIdx] = n.src.split(":").map(Number);
        const srcInfo = artifact.fileMap.get(fileIdx);
        sol.assert(srcInfo !== undefined && srcInfo.contents !== undefined, ``);
        const fileLoc = srcLoc.indexToLocation(srcInfo.contents, start, true);

        return [fileLoc.line, fileLoc.column];
    }

    getConstants(arg: ArtifactInfo): ConstantsInfo {
        let res = this._constantsCache.get(arg);

        if (res) {
            return res;
        }

        // Compute res
        res = gatherConstants(this, arg);
        this._constantsCache.set(arg, res);
        return res;
    }
}
