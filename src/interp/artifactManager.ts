import {
    ArtifactInfo,
    ArtifactManager as BaseArtifactManager,
    BaseMemoryView,
    Memory,
    Value,
    BaseRuntimeType
} from "sol-dbg";
import { gatherConstants } from "./constants";
import { assert, ASTNode } from "solc-typed-ast";

const srcLoc = require("src-location");

export type ConstantsMap = Map<number, BaseMemoryView<Value, BaseRuntimeType>>;
export type ConstantsInfo = [ConstantsMap, Memory];
export type FileLoc = [number, number]; // [line number, column number]

export class ArtifactManager extends BaseArtifactManager {
    _constantsCache: Map<ArtifactInfo, ConstantsInfo> = new Map();

    getStartLoc(n: ASTNode): FileLoc {
        const artifact = this.getArtifact(n);
        const [start, , fileIdx] = n.src.split(":").map(Number);
        const contents = artifact.fileMap.get(fileIdx);
        assert(contents !== undefined, ``);
        const fileLoc = srcLoc.indexToLocation(contents, start, true);

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
