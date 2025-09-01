import * as sol from "solc-typed-ast";
import { BaseType } from "./base_type";

type NamedDefinition =
    | sol.ContractDefinition
    | sol.ImportDirective
    | sol.FunctionDefinition
    | sol.EventDefinition
    | sol.ErrorDefinition
    | sol.StructDefinition
    | sol.EnumDefinition
    | sol.UserDefinedValueTypeDefinition;

export class DefType extends BaseType {
    constructor(public readonly def: NamedDefinition) {
        super();
    }

    get name(): string {
        if (this.def instanceof sol.ImportDirective) {
            return this.def.unitAlias;
        }

        return this.def.name;
    }

    get fullName(): string {
        let scope: string;
        if (this.def instanceof sol.ImportDirective) {
            scope = "";
        } else {
            scope =
                this.def.vScope instanceof sol.ContractDefinition ? `${this.def.vScope.name}.` : "";
        }

        return `${scope}${this.name}`;
    }

    get kind(): string {
        if (this.def instanceof sol.ContractDefinition) {
            return `contract`;
        }

        if (this.def instanceof sol.ImportDirective) {
            return `import`;
        }

        if (this.def instanceof sol.FunctionDefinition) {
            return `function`;
        }

        if (this.def instanceof sol.EventDefinition) {
            return `event`;
        }

        if (this.def instanceof sol.ErrorDefinition) {
            return `error`;
        }

        if (this.def instanceof sol.StructDefinition) {
            return `struct`;
        }

        if (this.def instanceof sol.EnumDefinition) {
            return `enum`;
        }

        sol.assert(this.def instanceof sol.UserDefinedValueTypeDefinition, ``);
        return `user-defined value`;
    }

    pp(): string {
        return `<def ${this.kind} ${this.name}>`;
    }
}
