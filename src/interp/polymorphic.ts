import { assert, DataLocation } from "solc-typed-ast";
import * as rtt from "sol-dbg";

export abstract class BasePolyType extends rtt.BaseRuntimeType { }

export class BaseTVar extends BasePolyType {
    constructor(public readonly name: string) {
        super();
    }

    pp(): string {
        return `<TVar ${this.name}>`;
    }
}

// Single type var
export class TVar extends BaseTVar { }

export class TUnion extends BaseTVar {
    private static ctr: number = 0;
    constructor(public readonly options: rtt.BaseRuntimeType[]) {
        super(`__tunion__${TUnion.ctr++}`);
    }

    pp(): string {
        return `<${this.options.map((opT) => opT.pp()).join("| ")}>`;
    }
}

// TOptional is a hack to support checking optional arguments.
// Note that it is only handled by concretize, it is not supported by unify.
export class TOptional extends BasePolyType {
    constructor(public readonly subT: rtt.BaseRuntimeType) {
        super();
    }

    pp(): string {
        return `<optional ${this.subT.pp()}>`;
    }
}

// Type var corresponding to the remaining arguments of a function(something like ...args: any[])
// Note that it is only handled by concretize, it is not supported by unify.
export class TRest extends BaseTVar {
    private static ctr: number = 0;

    constructor() {
        super(`__trest__${TRest.ctr++}`);
    }
}

function containsTVar(t: rtt.BaseRuntimeType, v: BaseTVar): boolean {
    if (t instanceof BaseTVar && t.name === v.name) {
        return true;
    }

    if (t instanceof rtt.PointerType) {
        return containsTVar(t.toType, v);
    }

    if (t instanceof rtt.ArrayType) {
        return containsTVar(t.elementT, v);
    }

    if (t instanceof rtt.StructType) {
        for (const [, fieldT] of t.fields) {
            if (containsTVar(fieldT, v)) {
                return true;
            }
        }
    }

    if (t instanceof rtt.MappingType) {
        return containsTVar(t.keyType, v) || containsTVar(t.valueType, v);
    }

    if (t instanceof rtt.TupleType) {
        for (const elT of t.elementTypes) {
            if (containsTVar(elT, v)) {
                return true;
            }
        }
    }

    if (t instanceof TOptional) {
        return containsTVar(t.subT, v);
    }

    if (t instanceof TUnion) {
        for (const opt of t.options) {
            if (containsTVar(opt, v)) {
                return true;
            }
        }

        return false;
    }

    return false;
}

export function isPolymorphic(t: rtt.BaseRuntimeType): boolean {
    if (t instanceof BasePolyType) {
        return true;
    }

    if (t instanceof rtt.PointerType) {
        return isPolymorphic(t.toType);
    }

    if (t instanceof rtt.ArrayType) {
        return isPolymorphic(t.elementT);
    }

    if (t instanceof rtt.StructType) {
        for (const [, fieldT] of t.fields) {
            if (isPolymorphic(fieldT)) {
                return true;
            }
        }
    }

    if (t instanceof rtt.MappingType) {
        return isPolymorphic(t.keyType) || isPolymorphic(t.valueType);
    }

    if (t instanceof rtt.TupleType) {
        for (const elT of t.elementTypes) {
            if (isPolymorphic(elT)) {
                return true;
            }
        }

        return false;
    }

    return false;
}

export type TSubst = Map<string, rtt.BaseRuntimeType>;

/**
 * Returns true IFF t1 unifies with t2 under type substitution subst. It modifies subst
 */
export function unify(t1: rtt.BaseRuntimeType, t2: rtt.BaseRuntimeType, subst: TSubst): boolean {
    t1 = substitute(t1, subst);
    t2 = substitute(t2, subst);

    if (t1.pp() === t2.pp()) {
        return true;
    }

    if (t2 instanceof TVar) {
        const tmp = t2;
        t2 = t1;
        t1 = tmp;
    }

    if (t1 instanceof TVar) {
        // Circular dependency
        if (containsTVar(t2, t1)) {
            return false;
        }

        subst.set(t1.name, t2);
        return true;
    }

    if (t1 instanceof rtt.ArrayType && t2 instanceof rtt.ArrayType && t1.size === t2.size) {
        return unify(t1.elementT, t2.elementT, subst);
    }

    if (
        t1 instanceof rtt.StructType &&
        t2 instanceof rtt.StructType &&
        t1.fields.length === t2.fields.length
    ) {
        for (let i = 0; i < t1.fields.length; i++) {
            const [f1Name, f1Type] = t1.fields[i];
            const [f2Name, f2Type] = t2.fields[i];

            if (f1Name !== f2Name || !unify(f1Type, f2Type, subst)) {
                return false;
            }
        }

        return true;
    }

    if (t1 instanceof rtt.PointerType && t2 instanceof rtt.PointerType) {
        // As a hack we consider DataLocation.Default to be a * for locations
        if (
            t1.location !== t2.location &&
            t1.location !== DataLocation.Default &&
            t2.location !== DataLocation.Default
        ) {
            return false;
        }

        return unify(t1.toType, t2.toType, subst);
    }

    // Unify tuples with some fields being optional
    if (t1 instanceof rtt.TupleType && t2 instanceof rtt.TupleType) {
        if (t2.elementTypes.length < t1.elementTypes.length) {
            const tmp: rtt.TupleType = t1;
            t1 = t2 as rtt.TupleType;
            t2 = tmp as rtt.TupleType;
        }

        // Pacify typescript
        assert(t1 instanceof rtt.TupleType && t2 instanceof rtt.TupleType, ``);

        for (let i = 0; i < t1.elementTypes.length; i++) {
            const t1El = t1.elementTypes[i];
            const t2El = t2.elementTypes[i];

            if (t1El instanceof TRest && i === t1.elementTypes.length - 1) {
                subst.set(t1El.name, new rtt.TupleType(t2.elementTypes.slice(i)))
                return true;
            }

            if (!unify(t1El, t2El, subst)) {
                return false;
            }
        }

        for (let i = t1.elementTypes.length; i < t2.elementTypes.length; i++) {
            if (!(t2.elementTypes[i] instanceof TOptional)) {
                return false;
            }
        }

        return true;
    }

    if (t2 instanceof TUnion) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
    }

    if (t1 instanceof TUnion) {
        for (const optT of t1.options) {
            const substCopy: TSubst = new Map(subst.entries());

            if (unify(optT, t2, substCopy)) {
                for (const [k, v] of substCopy) {
                    subst.set(k, v);
                }

                subst.set(t1.name, optT);

                return true;
            }
        }

        return false;
    }

    return false;
}

/**
 * Given a polymorphic type `t1` and a concrete type `t2` that should (mostly)
 * agree with it, concretize `t1` to (mostly) match `t2`.  The context is that
 * this is used to concretize the polymorphic types of builtins according to the
 * call site. The concrete types may not be exactly unifiable due to implicit
 * casts. For example in `arr.push("abc")`  the concrete args [string storage[]
 * storage, string memory] don't unify with the polymorphic args [T[] storage,
 * T]).
 *
 * However its sufficient to concretize tuple args left to right until they are fully concrete
 * to get the right concrete type.
 *
 * Also this handles TRest.
 */
export function concretize(
    formalTypes: rtt.BaseRuntimeType[],
    concreteTypes: rtt.BaseRuntimeType[]
): [rtt.BaseRuntimeType[], TSubst] {
    const subst: TSubst = new Map();
    const res: rtt.BaseRuntimeType[] = [];

    for (let i = 0; i < formalTypes.length; i++) {
        let formalT = formalTypes[i];

        if (formalT instanceof TRest) {
            res.push(...concreteTypes.slice(i));
            assert(
                i === formalTypes.length - 1,
                `Unexpected TRest not in the last position in concretize`
            );
            return [res, subst];
        }

        if (formalT instanceof TOptional) {
            if (i >= concreteTypes.length) {
                continue;
            }

            formalT = formalT.subT;
        }

        let substitutedT = substitute(formalT, subst);
        assert(i < concreteTypes.length, `Fewer concrete types than formal`);
        const concreteT = concreteTypes[i];

        if (isPolymorphic(substitutedT)) {
            assert(
                unify(substitutedT, concreteT, subst),
                `Couldn't unify {0} and {1}`,
                substitutedT,
                concreteT
            );
            substitutedT = substitute(substitutedT, subst);
        }

        res.push(substitutedT);
    }

    return [res, subst];
}

/**
 * Replace all TVars inside `t` according to `subst`.
 * As a small optimization, if no substitution happened, we return the same type without allocations
 */
export function substitute(t: rtt.BaseRuntimeType, subst: TSubst): rtt.BaseRuntimeType {
    if (t instanceof BaseTVar) {
        const res = subst.get(t.name);
        return res !== undefined ? substitute(res, subst) : t;
    }

    if (t instanceof rtt.PointerType) {
        const toT = substitute(t.toType, subst);
        return toT === t.toType ? t : new rtt.PointerType(toT, t.location);
    }

    if (t instanceof rtt.ArrayType) {
        const elT = substitute(t.elementT, subst);
        return elT === t.elementT ? t : new rtt.ArrayType(elT, t.size);
    }

    if (t instanceof rtt.StructType) {
        const fields: Array<[string, rtt.BaseRuntimeType]> = t.fields.map(([name, fieldT]) => [
            name,
            substitute(fieldT, subst)
        ]);
        return new rtt.StructType(t.name, fields);
    }

    if (t instanceof TOptional) {
        const innerT = substitute(t.subT, subst);

        return innerT === t.subT ? t : new TOptional(innerT);
    }

    if (t instanceof rtt.TupleType) {
        return new rtt.TupleType(t.elementTypes.map((elT) => substitute(elT, subst)));
    }

    if (t instanceof rtt.MappingType) {
        const keyT = substitute(t.keyType, subst);
        const valueT = substitute(t.valueType, subst);

        return keyT == t.keyType && valueT == t.valueType ? t : new rtt.MappingType(keyT, valueT);
    }

    // Shouldn't contain types inside
    return t;
}
