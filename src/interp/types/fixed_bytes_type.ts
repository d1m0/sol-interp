import { BaseType } from "./base_type";

export class FixedBytesType extends BaseType {
    constructor(public readonly numBytes: number) {
        super();
    }

    pp(): string {
        return `bytes${this.numBytes}`;
    }
}