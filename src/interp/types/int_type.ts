import { BaseType } from "./base_type";

export class IntType extends BaseType {
    constructor(public readonly numBits: number, public readonly signed: boolean) {
        super();
    }

    pp(): string {
        return `${this.signed ? '' : 'u'}int${this.numBits}`;
    }
}