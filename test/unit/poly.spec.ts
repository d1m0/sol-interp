import { ExpStructType, uint256, uint8 } from "sol-dbg";
import * as sol from "solc-typed-ast";
import { concretize, substitute, TOptional, TRest, TUnion, TVar, unify } from "../../src";

const s1 = new ExpStructType("s1", [
    ["a", sol.types.uint256],
    ["b", sol.types.uint256]
]);

const s1_copy = new ExpStructType("s1", [
    ["a", sol.types.uint256],
    ["b", sol.types.uint256]
]);

const s2 = new ExpStructType("s2", [
    ["a", sol.types.uint256],
    ["c", sol.types.uint256]
]);

const s3 = new ExpStructType("s3", [
    ["a", sol.types.uint256],
    ["b", sol.types.uint160]
]);

const a = new TVar("a");
const b = new TVar("b");
const c = new TVar("c");

const unificationSamples: Array<[sol.TypeNode, sol.TypeNode, boolean]> = [
    [sol.types.uint160, sol.types.uint160, true],
    [sol.types.uint256, sol.types.uint160, false],
    [sol.types.bytesMemory, sol.types.bytesMemory, true],
    [sol.types.bytesMemory, sol.types.stringMemory, false],
    [sol.types.bytesMemory, sol.types.bytesCalldata, false],
    [new sol.ArrayType(sol.types.uint160), new sol.ArrayType(sol.types.uint160), true],
    [new sol.ArrayType(sol.types.uint160, 5n), new sol.ArrayType(sol.types.uint160), false],
    [new sol.ArrayType(sol.types.uint160), new sol.ArrayType(sol.types.uint256), false],
    [s1, s1_copy, true],
    [s1, s2, false],
    [s1, s3, false],
    [a, b, true],
    [
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new ExpStructType("a", [
            ["f1", b],
            ["f2", b]
        ]),
        true
    ],
    [
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new ExpStructType("a", [
            ["f1", b],
            ["f2", c]
        ]),
        true
    ],
    [
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new ExpStructType("a", [
            ["f1", uint256],
            ["f2", uint8]
        ]),
        false
    ],
    [
        new sol.ArrayType(a),
        new sol.ArrayType(new sol.PointerType(new sol.ArrayType(b), sol.DataLocation.Memory)),
        true
    ],
    [
        new sol.ArrayType(a),
        new sol.ArrayType(new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Memory)),
        false
    ],
    [
        new ExpStructType("a", [
            ["a", a],
            ["b", new sol.ArrayType(uint256, 5n)]
        ]),
        new ExpStructType("a", [
            ["a", new sol.PointerType(new sol.ArrayType(b), sol.DataLocation.Memory)],
            ["b", b]
        ]),
        true
    ],
    [new sol.TupleType([a, b]), new sol.TupleType([b, c]), true],
    [new sol.TupleType([a, a]), new sol.TupleType([uint256, uint8]), false],
    [new TUnion([uint256, uint8]), uint8, true],
    [new TUnion([uint256, uint8]), sol.types.address, false],
    [new sol.TupleType([a]), new sol.TupleType([uint256, uint8]), false],
    [new sol.ArrayType(a), new sol.ArrayType(uint8, 5n), false],
    [new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Memory), new sol.PointerType(new sol.ArrayType(uint8), sol.DataLocation.Storage), false]
];

const substSamples: Array<[sol.TypeNode, sol.TypeNode, sol.TypeNode]> = [
    [a, b, a],
    [
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new ExpStructType("a", [
            ["f1", b],
            ["f2", b]
        ]),
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ])
    ],
    [
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new ExpStructType("a", [
            ["f1", b],
            ["f2", c]
        ]),
        new ExpStructType("a", [
            ["f1", a],
            ["f2", a]
        ])
    ],
    [
        new sol.ArrayType(a),
        new sol.ArrayType(new sol.PointerType(new sol.ArrayType(b), sol.DataLocation.Memory)),
        new sol.ArrayType(new sol.PointerType(new sol.ArrayType(b), sol.DataLocation.Memory))
    ],
    [
        new ExpStructType("a", [
            ["a", a],
            ["b", new sol.PointerType(new sol.ArrayType(uint256, 5n), sol.DataLocation.Memory)]
        ]),
        new ExpStructType("a", [
            ["a", new sol.PointerType(new sol.ArrayType(b), sol.DataLocation.Memory)],
            ["b", b]
        ]),
        new ExpStructType("a", [
            [
                "a",
                new sol.PointerType(
                    new sol.ArrayType(
                        new sol.PointerType(new sol.ArrayType(uint256, 5n), sol.DataLocation.Memory)
                    ),
                    sol.DataLocation.Memory
                )
            ],
            ["b", new sol.PointerType(new sol.ArrayType(uint256, 5n), sol.DataLocation.Memory)]
        ])
    ],
    [
        new TUnion([uint256, uint8]),
        uint8,
        uint8
    ],
    [
        new TUnion([uint256, new sol.PointerType(new sol.ArrayType(a, 5n), sol.DataLocation.Memory)]),
        new sol.PointerType(new sol.ArrayType(uint256, 5n), sol.DataLocation.Memory),
        new sol.PointerType(new sol.ArrayType(uint256, 5n), sol.DataLocation.Memory),
    ]
];

const concretizeTests: Array<[sol.TypeNode[], sol.TypeNode[], sol.TypeNode[] | undefined]> = [
    [
        [uint256, uint8],
        [sol.types.address, sol.types.bool],
        [uint256, uint8]
    ],
    [[uint256, new TOptional(uint8)], [uint256], [uint256]],
    [
        [uint256, new TOptional(uint8)],
        [uint256, uint8],
        [uint256, uint8]
    ],
    [[uint256, new TOptional(new TUnion([uint8, uint256]))], [uint256, sol.types.bool], undefined],
    [[uint256, uint8], [uint256], undefined],
    [
        [new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Memory), a],
        [new sol.PointerType(new sol.ArrayType(uint8), sol.DataLocation.Memory), uint256],
        [new sol.PointerType(new sol.ArrayType(uint8), sol.DataLocation.Memory), uint8]
    ],
    [
        [uint256, new TRest()],
        [uint256, uint8, uint256],
        [uint256, uint8, uint256]
    ],
    [
        [uint256, new TRest()],
        [uint256],
        [uint256]
    ],
    [
        [new sol.PointerType(new sol.ArrayType(a), sol.DataLocation.Memory), a, new TRest()],
        [new sol.PointerType(new sol.ArrayType(uint8), sol.DataLocation.Memory), uint256, uint8],
        [new sol.PointerType(new sol.ArrayType(uint8), sol.DataLocation.Memory), uint8, uint8]
    ],
];

function ppTypes(ts: sol.TypeNode[]): string {
    return ts.map((t) => t.pp()).join(", ");
}

describe("Polymorphism tests", () => {
    describe("Unification tests", () => {
        for (const [t1, t2, expectedRes] of unificationSamples) {
            it(`Unify ${t1.pp()} and ${t2.pp()} ${expectedRes ? "succeeds" : "fails"}`, () => {
                const res = unify(t1, t2, new Map());
                expect(res).toEqual(expectedRes);
            });
        }
    });

    describe("Substitution tests", () => {
        for (const [t1, t2, expectedRes] of substSamples) {
            it(`After unification ${t1.pp()} and ${t2.pp()} become ${expectedRes.pp()}`, () => {
                const subst = new Map();
                const t = unify(t1, t2, subst);
                expect(t).toEqual(true);
                const res = substitute(t1, subst);
                expect(res.pp()).toEqual(substitute(t2, subst).pp());
                expect(res.pp()).toEqual(expectedRes.pp());
            });
        }
    });

    describe("Concretization tests", () => {
        for (const [t1, t2, expected] of concretizeTests) {
            it(`Concretizing ${ppTypes(t1)} and ${ppTypes(t2)} become ${expected !== undefined ? ppTypes(expected) : "<exception>"}`, () => {
                if (expected !== undefined) {
                    const [res] = concretize(t1, t2);
                    expect(ppTypes(res)).toEqual(ppTypes(expected));
                } else {
                    expect(() => concretize(t1, t2)).toThrow();
                }
            });
        }
    });
});
