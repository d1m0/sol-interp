import { ArrayType } from "../array_type";
import { BaseFunctionType } from "../base_function_type";
import { BaseType } from "../base_type";
import { ExternalFunctionType } from "../external_function_type";
import { InternalFunctionType } from "../internal_function_type";
import { MappingType } from "../mapping_type";
import { PointerType } from "../pointer_type";
import { StructType } from "../struct_type";
import { TupleType } from "../tuple_type";
import { BasePolyType } from "./base_poly_type";
import { BaseTVar } from "./base_tvar";
import { TOptional } from "./toptional";
import { TRest } from "./trest";
import { TUnion } from "./tunion";
import { TVar } from "./tvar";

import { assert } from "solc-typed-ast";

export type TSubst = Map<string, BaseType>;

/**
 * Returns true IFF the type `t` contains the type var `v`.
 */
function containsTVar(t: BaseType, v: BaseTVar): boolean {
    if (t instanceof BaseTVar && t.name === v.name) {
        return true;
    }

    if (t instanceof PointerType) {
        return containsTVar(t.toType, v);
    }

    if (t instanceof ArrayType) {
        return containsTVar(t.elementT, v);
    }

    if (t instanceof StructType) {
        for (const [, fieldT] of t.fields) {
            if (containsTVar(fieldT, v)) {
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

    if (t instanceof BaseFunctionType) {
        for (const paramT of t.parameters) {
            if (containsTVar(paramT, v)) {
                return true;
            }
        }

        for (const paramT of t.returns) {
            if (containsTVar(paramT, v)) {
                return true;
            }
        }
    }

    if (t instanceof TupleType) {
        for (const elT of t.elementTypes) {
            if (containsTVar(elT, v)) {
                return true;
            }
        }
    }

    if (t instanceof MappingType) {
        if (containsTVar(t.keyType, v) || containsTVar(t.valueType, v)) {
            return true;
        }
    }

    return false;
}

/**
 * Returns true IFF `t` is a polymorphic type.
 */
export function isPolymorphic(t: BaseType): boolean {
    if (t instanceof BasePolyType) {
        return true;
    }

    if (t instanceof PointerType) {
        return isPolymorphic(t.toType);
    }

    if (t instanceof ArrayType) {
        return isPolymorphic(t.elementT);
    }

    if (t instanceof StructType) {
        for (const [, fieldT] of t.fields) {
            if (isPolymorphic(fieldT)) {
                return true;
            }
        }
    }

    if (t instanceof BaseFunctionType) {
        for (const paramT of t.parameters) {
            if (isPolymorphic(paramT)) {
                return true;
            }
        }

        for (const paramT of t.returns) {
            if (isPolymorphic(paramT)) {
                return true;
            }
        }
    }

    if (t instanceof TupleType) {
        for (const elT of t.elementTypes) {
            if (isPolymorphic(elT)) {
                return true;
            }
        }
    }

    if (t instanceof MappingType) {
        return isPolymorphic(t.keyType) || isPolymorphic(t.valueType);
    }

    return false;
}

/**
 * Replace all TVars inside `t` according to `subst`.
 * As a small optimization, if no substitution happened, we return the same type without allocations
 */
export function substitute(t: BaseType, subst: TSubst): BaseType {
    if (t instanceof BaseTVar && subst.has(t.name)) {
        const res = subst.get(t.name) as BaseType;
        return substitute(res, subst);
    }

    if (t instanceof PointerType) {
        const toT = substitute(t.toType, subst);
        return toT === t.toType ? t : new PointerType(toT, t.location);
    }

    if (t instanceof ArrayType) {
        const elT = substitute(t.elementT, subst);
        return elT === t.elementT ? t : new ArrayType(elT, t.size);
    }

    if (t instanceof StructType) {
        const fields: Array<[string, BaseType]> = t.fields.map(([name, fieldT]) => [
            name,
            substitute(fieldT, subst)
        ]);
        return new StructType(t.name, fields);
    }

    if (t instanceof TOptional) {
        const innerT = substitute(t.subT, subst);

        return innerT === t.subT ? t : new TOptional(innerT);
    }

    if (t instanceof TUnion) {
        return new TUnion(t.options.map((opt) => substitute(opt, subst)));
    }

    if (t instanceof BaseFunctionType) {
        const constr =
            t instanceof InternalFunctionType ? InternalFunctionType : ExternalFunctionType;
        return new constr(
            t.parameters.map((pT) => substitute(pT, subst)),
            t.returns.map((rT) => substitute(rT, subst))
        );
    }

    if (t instanceof TupleType) {
        return new TupleType(t.elementTypes.map((elT) => substitute(elT, subst)));
    }

    if (t instanceof MappingType) {
        return new MappingType(substitute(t.keyType, subst), substitute(t.valueType, subst));
    }

    // Shouldn't contain types inside
    return t;
}

/**
 * Returns true IFF t1 unifies with t2 under type substitution subst.
 * As types are unified subst is destructively modified to accumulate the substitution.
 * This happens even if we return false.
 *
 * Note that this handles a limit subset of the types, which appear in
 * builtin args.
 */
export function unify(t1: BaseType, t2: BaseType, subst: TSubst): boolean {
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

    if (t1 instanceof ArrayType && t2 instanceof ArrayType && t1.size === t2.size) {
        return unify(t1.elementT, t2.elementT, subst);
    }

    if (
        t1 instanceof StructType &&
        t2 instanceof StructType &&
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

    if (t1 instanceof PointerType && t2 instanceof PointerType) {
        if (t1.location !== t2.location) {
            return false;
        }

        return unify(t1.toType, t2.toType, subst);
    }

    // Unify tuples with some fields being optional
    if (t1 instanceof TupleType && t2 instanceof TupleType) {
        if (t2.elementTypes.length < t1.elementTypes.length) {
            const tmp: TupleType = t1;
            t1 = t2 as TupleType;
            t2 = tmp as TupleType;
        }

        // Pacify typescript
        assert(t1 instanceof TupleType && t2 instanceof TupleType, ``);

        for (let i = 0; i < t1.elementTypes.length; i++) {
            const t1El = t1.elementTypes[i];
            const t2El = t2.elementTypes[i];

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
 * Also this handles TRest and TOptional
 * @todo (dimo): Go over this fun again. Feels hacky. There has to be a better way
 * to implement this.
 */
export function concretize(
    formalTypes: BaseType[],
    concreteTypes: BaseType[]
): [BaseType[], TSubst] {
    const subst: TSubst = new Map();
    const res: BaseType[] = [];

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
