import { BaseType } from "./base_type";

export class MappingType extends BaseType {
    constructor(public readonly keyType: BaseType, public readonly valueType: BaseType) {
        super();
    }

    pp(): string {
        return `mapping(${this.keyType.pp()} => ${this.valueType.pp()})`;
    }
}