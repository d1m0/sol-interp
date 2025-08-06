import { ExpStructType } from "sol-dbg";
import * as sol from "solc-typed-ast";

export abstract class BasePolyType extends sol.TypeNode {}

export class BaseTVar extends BasePolyType {
    constructor(public readonly name: string) {
        super();
    }

    pp(): string {
        return `<TVar ${this.name}>`;
    }
}

// Single type var
export class TVar extends BaseTVar {}

export class TUnion extends BaseTVar {
    private static ctr: number = 0;
    constructor(public readonly options: sol.TypeNode[]) {
        super(`__tunion__${TUnion.ctr++}`);
    }

    pp(): string {
        return `<${this.options.map((opT) => opT.pp()).join("| ")}>`;
    }
}

// TOptional is a hack to support checking optional arguments.
// Note that it is only handled by concretize, it is not supported by unify.
export class TOptional extends BasePolyType {
    constructor(public readonly subT: sol.TypeNode) {
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

function containsTVar(t: sol.TypeNode, v: BaseTVar): boolean {
    if (t instanceof BaseTVar && t.name === v.name) {
        return true;
    }

    if (t instanceof sol.PointerType) {
        return containsTVar(t.to, v);
    }

    if (t instanceof sol.ArrayType) {
        return containsTVar(t.elementT, v);
    }

    if (t instanceof ExpStructType) {
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

    return false;
}

export function isPolymorphic(t: sol.TypeNode): boolean {
    if (t instanceof BasePolyType) {
        return true;
    }

    if (t instanceof sol.PointerType) {
        return isPolymorphic(t.to);
    }

    if (t instanceof sol.ArrayType) {
        return isPolymorphic(t.elementT);
    }

    if (t instanceof ExpStructType) {
        for (const [, fieldT] of t.fields) {
            if (isPolymorphic(fieldT)) {
                return true;
            }
        }
    }

    return false;
}

export type TSubst = Map<string, sol.TypeNode>;

/**
 * Returns true IFF t1 unifies with t2 under type substitution subst. It modifies subst
 */
export function unify(t1: sol.TypeNode, t2: sol.TypeNode, subst: TSubst): boolean {
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

    if (t1 instanceof sol.ArrayType && t2 instanceof sol.ArrayType && t1.size === t2.size) {
        return unify(t1.elementT, t2.elementT, subst);
    }

    if (
        t1 instanceof ExpStructType &&
        t2 instanceof ExpStructType &&
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

    if (t1 instanceof sol.PointerType && t2 instanceof sol.PointerType) {
        // As a hack we consider DataLocation.Default to be a * for locations
        if (
            t1.location !== t2.location &&
            t1.location !== sol.DataLocation.Default &&
            t2.location !== sol.DataLocation.Default
        ) {
            return false;
        }

        return unify(t1.to, t2.to, subst);
    }

    // Unify tuples with some fields being optional
    if (t1 instanceof sol.TupleType && t2 instanceof sol.TupleType) {
        if (t2.elements.length < t1.elements.length) {
            const tmp: sol.TupleType = t1;
            t1 = t2 as sol.TupleType;
            t2 = tmp as sol.TupleType;
        }

        // Pacify typescript
        sol.assert(t1 instanceof sol.TupleType && t2 instanceof sol.TupleType, ``);

        for (let i = 0; i < t1.elements.length; i++) {
            const t1El = t1.elements[i];
            const t2El = t2.elements[i];

            sol.assert(t1El !== null && t2El !== null, ``);

            if (!unify(t1El, t2El, subst)) {
                return false;
            }
        }

        for (let i = t1.elements.length; i < t2.elements.length; i++) {
            if (!(t2.elements[i] instanceof TOptional)) {
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
    formalTypes: sol.TypeNode[],
    concreteTypes: sol.TypeNode[]
): [sol.TypeNode[], TSubst] {
    const subst: TSubst = new Map();
    const res: sol.TypeNode[] = [];

    for (let i = 0; i < formalTypes.length; i++) {
        let formalT = formalTypes[i];

        if (formalT instanceof TRest) {
            res.push(...(concreteTypes.slice(i) as sol.TypeNode[]));
            sol.assert(
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
        sol.assert(i < concreteTypes.length, `Fewer concrete types than formal`);
        const concreteT = concreteTypes[i] as sol.TypeNode;

        if (isPolymorphic(substitutedT)) {
            sol.assert(
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
export function substitute(t: sol.TypeNode, subst: TSubst): sol.TypeNode {
    if (t instanceof BaseTVar) {
        const res = subst.get(t.name);
        return res !== undefined ? substitute(res, subst) : t;
    }

    if (t instanceof sol.PointerType) {
        const toT = substitute(t.to, subst);
        return toT === t.to ? t : new sol.PointerType(toT, t.location, t.kind);
    }

    if (t instanceof sol.ArrayType) {
        const elT = substitute(t.elementT, subst);
        return elT === t.elementT ? t : new sol.ArrayType(elT, t.size);
    }

    if (t instanceof ExpStructType) {
        const fields: Array<[string, sol.TypeNode]> = t.fields.map(([name, fieldT]) => [
            name,
            substitute(fieldT, subst)
        ]);
        return new ExpStructType(t.name, fields);
    }

    if (t instanceof TOptional) {
        const innerT = substitute(t.subT, subst);

        return innerT === t.subT ? t : new TOptional(innerT);
    }

    // Shouldn't contain types inside
    return t;
}
