import * as sol from "solc-typed-ast";
import { BaseType } from "./base_type";

export class PointerType extends BaseType {
    constructor(public readonly toType: BaseType, public readonly location: sol.DataLocation) {
        super();
        sol.assert(location !== sol.DataLocation.Default, `Unexpected pointer type with default location`);
    }

    pp(): string {
        return `${this.toType.pp()} ${this.location}`
    }
}