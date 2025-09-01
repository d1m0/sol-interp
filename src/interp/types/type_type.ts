import { BaseType } from "./base_type";

/**
 * Type of a 'type' expression/local.
 */
export class TypeType extends BaseType {
    pp(): string {
        return `<type>`;
    }
}
