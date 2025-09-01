import { BaseType } from "./base_type";

export class TupleType extends BaseType {
    constructor(public readonly elementTypes: BaseType[]) {
        super();
    }

    pp(): string {
        return `(${this.elementTypes.map((t) => t.pp()).join(", ")})`;
    }
}
