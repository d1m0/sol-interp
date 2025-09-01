import { BaseType } from "./base_type";

export abstract class BaseFunctionType extends BaseType {
    constructor(public readonly parameters: BaseType[], public readonly returns: BaseType[]) {
        super();
    }

    pp(): string {
        return `function (${this.parameters.map((pT) => pT.pp()).join(", ")}): [${this.returns.map((retT) => retT.pp()).join(', ')}]`
    }
}