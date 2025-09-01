import { BaseType } from "./base_type";

export class StructType extends BaseType {
    constructor(public readonly name: string, public readonly fields: [string, BaseType][]) {
        super();
    }

    pp(): string {
        return `struct ${this.name}`;
    }
}