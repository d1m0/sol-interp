import {
    ArtifactInfo,
    ArtifactManager as BaseArtifactManager,
    BaseMemoryView,
    Memory,
    Value
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import { gatherConstants } from "./constants";

export type ConstantsMap = Map<number, BaseMemoryView<Value, sol.TypeNode>>;
export type ConstantsInfo = [ConstantsMap, Memory];

export class ArtifactManager extends BaseArtifactManager {
    _constantsCache: Map<ArtifactInfo, ConstantsInfo> = new Map();

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
