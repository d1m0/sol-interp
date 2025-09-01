import { BaseType } from "../base_type";
import { BaseTVar } from "./base_tvar";

export class TUnion extends BaseTVar {
    private static ctr: number = 0;
    constructor(public readonly options: BaseType[]) {
        super(`__tunion__${TUnion.ctr++}`);
    }

    pp(): string {
        return `<${this.options.map((opT) => opT.pp()).join("| ")}>`;
    }
}