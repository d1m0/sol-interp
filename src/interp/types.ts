import * as rtt from "sol-dbg";
import * as sol from "solc-typed-ast";
import { memBytesT } from "./utils";

export type BaseInterpType = rtt.BaseRuntimeType;
export class WrappedType extends rtt.BaseRuntimeType {
    constructor(public readonly innerT: sol.TypeIdentifier) {
        super();
    }

    pp(): string {
        return `<${this.innerT.pp()}>`;
    }
}

export class ArraySliceType extends rtt.BaseRuntimeType {
    pp(): string {
        return `<slice ${this.innerT.pp()}>`;
    }
    constructor(public readonly innerT: rtt.PointerType) {
        super();
    }
}

export class RationalNumberType extends rtt.BaseRuntimeType {
    constructor(
        public readonly numerator: bigint,
        public readonly denominator: bigint
    ) {
        super();
    }

    pp(): string {
        return `<rational ${this.numerator}/${this.denominator}>`;
    }

    isInt(): boolean {
        return this.denominator === 1n;
    }

    asInt(): bigint {
        sol.assert(this.denominator === 1n, ``);
        return this.numerator;
    }
}

/**
 * Convert the given TypeIdentifier to a runtime type. This is build on top of sol-dbg's
 * `typeIdToRuntimeType` but adds support for several solidity types that appear only in the AST:
 *
 * @param rawT
 */
export function typeIdToRuntimeType(
    rawT: sol.TypeIdentifier,
    ctx: sol.ASTContext,
    loc: sol.DataLocation | undefined = undefined
): BaseInterpType {
    // Handle compound cases
    if (rawT instanceof sol.ArrayTypeId) {
        const expElT = typeIdToRuntimeType(rawT.elT, ctx, loc);

        return new rtt.ArrayType(expElT, rawT.size);
    }

    if (rawT instanceof sol.MappingTypeId) {
        const keyT = typeIdToRuntimeType(rawT.keyType, ctx, loc);
        const valueT = typeIdToRuntimeType(rawT.valueType, ctx, loc);

        return new rtt.MappingType(keyT, valueT);
    }

    if (rawT instanceof sol.TupleTypeId) {
        return new rtt.TupleType(rawT.components.map((elT) => typeIdToRuntimeType(elT, ctx, loc)));
    }

    if (rawT instanceof sol.PointerTypeId) {
        const ptrLoc = rawT.location === sol.DataLocation.Default ? loc : rawT.location;
        sol.assert(ptrLoc !== undefined, `Missing location in conversion of {0}`, rawT);

        const toT = typeIdToRuntimeType(rawT.toType, ctx, ptrLoc);
        return new rtt.PointerType(toT, ptrLoc);
    }

    if (rawT instanceof sol.UserDefinedType && rawT.definition instanceof sol.StructDefinition) {
        sol.assert(loc !== undefined, `Missing location in struct expansion {0}`, rawT);
        const fields: Array<[string, BaseInterpType]> = rawT.definition.vMembers.map((decl) => [
            decl.name,
            typeIdToRuntimeType(sol.changeLocationTo(sol.typeOf(decl), loc), ctx, loc)
        ]);

        return new rtt.StructType(rawT.name, fields);
    }

    // ArraySliceTypeId
    if (rawT instanceof sol.ArraySliceTypeId) {
        const innerT = typeIdToRuntimeType(rawT.toType, ctx, loc);
        sol.assert(
            innerT instanceof rtt.PointerType,
            `Expected a pointer in a slice type not {0}`,
            innerT
        );
        return new ArraySliceType(innerT);
    }

    // Handle primitive cases not handled in sol-dbg
    // StringLiteralTypeId are treated as memory bytes.
    if (rawT instanceof sol.StringLiteralTypeId) {
        return memBytesT;
    }

    // RationalNumTypeId
    if (rawT instanceof sol.RationalNumTypeId) {
        return new RationalNumberType(rawT.numerator, rawT.denominator);
    }

    // BuiltinStructTypeId
    // ErrorTypeId
    // MetaTypeTypeId
    // ModuleTypeId
    // SuperTypeId
    // TypeTypeId
    if (
        rawT instanceof sol.BuiltinStructTypeId ||
        rawT instanceof sol.ErrorTypeId ||
        rawT instanceof sol.MetaTypeTypeId ||
        rawT instanceof sol.ModuleTypeId ||
        rawT instanceof sol.SuperTypeId ||
        rawT instanceof sol.TypeTypeId
    ) {
        return new WrappedType(rawT);
    }

    // These ones shouldn't appear in the interepter
    // ModifierTypeId
    if (rawT instanceof sol.ModifierTypeId) {
        sol.assert(false, `Unexpected type ${rawT.pp()}`);
    }

    // Rest is handled by sol-dbg
    return rtt.typeIdToRuntimeType(rawT, ctx, loc);
}
