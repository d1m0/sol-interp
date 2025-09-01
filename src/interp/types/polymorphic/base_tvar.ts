import { BasePolyType } from "./base_poly_type";

export abstract class BaseTVar extends BasePolyType {
    constructor(public readonly name: string) {
        super();
    }

    pp(): string {
        return `<tvar ${this.name}>`;
    }
}
