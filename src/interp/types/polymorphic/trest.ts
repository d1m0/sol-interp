import { BaseTVar } from "./base_tvar";

/**
 * Type var corresponding to the remaining arguments of a function(something like ...args: any[])
 * Note that it is only handled by concretize, it is not supported by unify.
 */
export class TRest extends BaseTVar {
    private static ctr: number = 0;

    constructor() {
        super(`__trest__${TRest.ctr++}`);
    }
}
