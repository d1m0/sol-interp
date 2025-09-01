import * as sol from "solc-typed-ast";
import * as interp from ".";
import { simplifyType } from "sol-dbg";

const addressT = new interp.AddressType();
const boolT = new interp.BoolType();
const bytesT = new interp.BytesType();

export function astToInterpType(
    raw: sol.TypeNode,
    infer: sol.InferType,
    loc?: sol.DataLocation
): interp.BaseType {
    // First simplify the type to sol-dbg's dialect
    const simplified = simplifyType(raw, infer, loc);

    if (simplified instanceof sol.AddressType) {
        return addressT;
    }

    if (simplified instanceof sol.ArrayType) {
        return new interp.ArrayType(
            astToInterpType(simplified.elementT, infer, loc),
            simplified.size
        );
    }

    if (simplified instanceof sol.FunctionType) {
        sol.assert(
            simplified.visibility === sol.FunctionVisibility.External ||
                simplified.visibility === sol.FunctionVisibility.Internal,
            `Invalid fun type visiblity ${simplified.visibility}`
        );
        const paramTs = simplified.parameters.map((paramT) => astToInterpType(paramT, infer));
        const retTs = simplified.returns.map((retT) => astToInterpType(retT, infer));

        return new (
            simplified.visibility === sol.FunctionVisibility.External
                ? interp.ExternalFunctionType
                : interp.InternalFunctionType
        )(paramTs, retTs);
    }

    if (simplified instanceof sol.BoolType) {
        return boolT;
    }

    if (simplified instanceof sol.BytesType) {
        return bytesT;
    }

    if (simplified instanceof sol.FixedBytesType) {
        return new interp.FixedBytesType(simplified.size);
    }

    if (simplified instanceof sol.IntType) {
        return new interp.IntType(simplified.nBits, simplified.signed);
    }

    if (simplified instanceof sol.MappingType) {
        const keyT = astToInterpType(simplified.keyType, infer, loc);
        const valueT = astToInterpType(simplified.valueType, infer, loc);
        return new interp.MappingType(keyT, valueT);
    }

    if (simplified instanceof sol.PointerType) {
        return new interp.PointerType(
            astToInterpType(simplified.to, infer, simplified.location),
            simplified.location
        );
    }
}
