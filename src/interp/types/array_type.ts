import { BaseType } from "./base_type";

export class ArrayType extends BaseType {
    constructor(public readonly elementT: BaseType, public readonly size?: bigint) {
        super();
    }

    pp(): string {
        return `${this.elementT.pp()}[${this.size !== undefined ? this.size : ''}]`
    }
}