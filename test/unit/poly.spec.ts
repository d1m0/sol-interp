import { uint256, uint8 } from "sol-dbg";
import * as rtt from "sol-dbg";
import * as sol from "solc-typed-ast";
import { concretize, substitute, TOptional, TRest, TUnion, TVar, unify } from "../../src";

const uint160 = new rtt.IntType(160, false);

const s1 = new rtt.StructType("s1", [
    ["a", rtt.uint256],
    ["b", rtt.uint256]
]);

const s1_copy = new rtt.StructType("s1", [
    ["a", rtt.uint256],
    ["b", rtt.uint256]
]);

const s2 = new rtt.StructType("s2", [
    ["a", rtt.uint256],
    ["c", rtt.uint256]
]);

const s3 = new rtt.StructType("s3", [
    ["a", rtt.uint256],
    ["b", uint160]
]);

const a = new TVar("a");
const b = new TVar("b");
const c = new TVar("c");

const unificationSamples: Array<[rtt.BaseRuntimeType, rtt.BaseRuntimeType, boolean]> = [
    [uint160, uint160, true],
    [rtt.uint256, uint160, false],
    [sol.types.bytesMemory, sol.types.bytesMemory, true],
    [sol.types.bytesMemory, sol.types.stringMemory, false],
    [sol.types.bytesMemory, sol.types.bytesCalldata, false],
    [new rtt.ArrayType(uint160), new rtt.ArrayType(uint160), true],
    [new rtt.ArrayType(uint160, 5n), new rtt.ArrayType(uint160), false],
    [new rtt.ArrayType(uint160), new rtt.ArrayType(rtt.uint256), false],
    [s1, s1_copy, true],
    [s1, s2, false],
    [s1, s3, false],
    [a, b, true],
    [
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new rtt.StructType("a", [
            ["f1", b],
            ["f2", b]
        ]),
        true
    ],
    [
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new rtt.StructType("a", [
            ["f1", b],
            ["f2", c]
        ]),
        true
    ],
    [
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new rtt.StructType("a", [
            ["f1", uint256],
            ["f2", uint8]
        ]),
        false
    ],
    [
        new rtt.ArrayType(a),
        new rtt.ArrayType(new rtt.PointerType(new rtt.ArrayType(b), sol.DataLocation.Memory)),
        true
    ],
    [
        new rtt.ArrayType(a),
        new rtt.ArrayType(new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Memory)),
        false
    ],
    [
        new rtt.StructType("a", [
            ["a", a],
            ["b", new rtt.ArrayType(uint256, 5n)]
        ]),
        new rtt.StructType("a", [
            ["a", new rtt.PointerType(new rtt.ArrayType(b), sol.DataLocation.Memory)],
            ["b", b]
        ]),
        true
    ],
    [new rtt.TupleType([a, b]), new rtt.TupleType([b, c]), true],
    [new rtt.TupleType([a, a]), new rtt.TupleType([uint256, uint8]), false],
    [new TUnion([uint256, uint8]), uint8, true],
    [new TUnion([uint256, uint8]), sol.types.address, false],
    [new rtt.TupleType([a]), new rtt.TupleType([uint256, uint8]), false],
    [new rtt.ArrayType(a), new rtt.ArrayType(uint8, 5n), false],
    [
        new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Memory),
        new rtt.PointerType(new rtt.ArrayType(uint8), sol.DataLocation.Storage),
        false
    ]
];

const substSamples: Array<[rtt.BaseRuntimeType, rtt.BaseRuntimeType, rtt.BaseRuntimeType]> = [
    [a, b, a],
    [
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new rtt.StructType("a", [
            ["f1", b],
            ["f2", b]
        ]),
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ])
    ],
    [
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ]),
        new rtt.StructType("a", [
            ["f1", b],
            ["f2", c]
        ]),
        new rtt.StructType("a", [
            ["f1", a],
            ["f2", a]
        ])
    ],
    [
        new rtt.ArrayType(a),
        new rtt.ArrayType(new rtt.PointerType(new rtt.ArrayType(b), sol.DataLocation.Memory)),
        new rtt.ArrayType(new rtt.PointerType(new rtt.ArrayType(b), sol.DataLocation.Memory))
    ],
    [
        new rtt.StructType("a", [
            ["a", a],
            ["b", new rtt.PointerType(new rtt.ArrayType(uint256, 5n), sol.DataLocation.Memory)]
        ]),
        new rtt.StructType("a", [
            ["a", new rtt.PointerType(new rtt.ArrayType(b), sol.DataLocation.Memory)],
            ["b", b]
        ]),
        new rtt.StructType("a", [
            [
                "a",
                new rtt.PointerType(
                    new rtt.ArrayType(
                        new rtt.PointerType(new rtt.ArrayType(uint256, 5n), sol.DataLocation.Memory)
                    ),
                    sol.DataLocation.Memory
                )
            ],
            ["b", new rtt.PointerType(new rtt.ArrayType(uint256, 5n), sol.DataLocation.Memory)]
        ])
    ],
    [new TUnion([uint256, uint8]), uint8, uint8],
    [
        new TUnion([
            uint256,
            new rtt.PointerType(new rtt.ArrayType(a, 5n), sol.DataLocation.Memory)
        ]),
        new rtt.PointerType(new rtt.ArrayType(uint256, 5n), sol.DataLocation.Memory),
        new rtt.PointerType(new rtt.ArrayType(uint256, 5n), sol.DataLocation.Memory)
    ]
];

const concretizeTests: Array<
    [rtt.BaseRuntimeType[], rtt.BaseRuntimeType[], rtt.BaseRuntimeType[] | undefined]
> = [
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
        [new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Memory), a],
        [new rtt.PointerType(new rtt.ArrayType(uint8), sol.DataLocation.Memory), uint256],
        [new rtt.PointerType(new rtt.ArrayType(uint8), sol.DataLocation.Memory), uint8]
    ],
    [
        [uint256, new TRest()],
        [uint256, uint8, uint256],
        [uint256, uint8, uint256]
    ],
    [[uint256, new TRest()], [uint256], [uint256]],
    [
        [new rtt.PointerType(new rtt.ArrayType(a), sol.DataLocation.Memory), a, new TRest()],
        [new rtt.PointerType(new rtt.ArrayType(uint8), sol.DataLocation.Memory), uint256, uint8],
        [new rtt.PointerType(new rtt.ArrayType(uint8), sol.DataLocation.Memory), uint8, uint8]
    ]
];

function ppTypes(ts: rtt.BaseRuntimeType[]): string {
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
