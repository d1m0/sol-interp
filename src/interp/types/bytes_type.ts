import { BaseType } from "./base_type";

export class BytesType extends BaseType {
    pp(): string {
        return `bytes`;
    }
}