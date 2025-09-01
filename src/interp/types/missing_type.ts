import { BaseType } from "./base_type";

/**
 * The local version of sol-dbg's MissingType.
 * @todo may deprecate this in the future
 */
export class MissingType extends BaseType {
    pp(): string {
        return `<mssing type>`
    }
}