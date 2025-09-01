import { BaseType } from "../base_type";
import { BasePolyType } from "./base_poly_type";

/**
 * TOptional is a hack to support checking optional arguments.
 * Note that it is only handled by concretize, it is not supported by unify.
 */
export class TOptional extends BasePolyType {
    constructor(public readonly subT: BaseType) {
        super();
    }

    pp(): string {
        return `<optional ${this.subT.pp()}>`;
    }
}