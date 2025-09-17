import { BaseRuntimeType } from "sol-dbg";

export class DefType extends BaseRuntimeType {
    pp(): string {
        return "<def>";
    }
}

export class TypeType extends BaseRuntimeType {
    pp(): string {
        return `<type>`
    }
}

export type BaseInterpType = BaseRuntimeType;
