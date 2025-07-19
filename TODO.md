0 - add mem array index location
1 - add mem bytes index location
2 - add cd array index location
3 - add cd bytes index location
4 - add storage array index location
5 - add storage bytes index location
6 - add storage map index location
7 - check if I implemented the isFailure checks correctly in the diff
8 - add memory fixed bytes indexing
11 - add storage fixed bytes indexing
12 - add calldata fixed bytes indexing
9 - add memory index tests
10 - add memory bytes test 
12 - add storage index tests
13 - add calldata index tests
14 - add storage map index
15 - add stroage map index rd tests
16 - add index write tests

17 - add mem struct field location
18 - add storage struct field location
19 - add calldata struct field location
20 - add field tests
21 - add recursive walk test

22 - make sol-dbg release
23 - bump release
24 - fix imports

25 - add interfaces
26 - add stack array-like view for fixed bytes
27 - add associated "isX" functions
28 - modify tests to use isX and size functions
29 - add stack indexing tests
30 - release & bump
31  - change SingleByteXView to return bigint instead
32 - translate Views to values in returns
33 - fix call test to convert views to values
37 - lock down eval to avoid poison (for now)
38 - replace all Number() casts and MAX_DECODE... checks with bigIntToNum
40 - implement index access
34    - get sol2maruir and page-in its translation of typeConversion
35    - get a skeleton for evalTypeConversion
36    - finish test for OoO for assignment
39 - experiment with splitting Value into PrimitiveValue and ComplexValue. This way an InterpValue becomes PrimitiveValue | View | DecodingError
   - Refactor scopes to use TypeLocalView (reasoning: Scopes are my stack, but they are not the typical low-level stack that I can manage with StackViews. So they are an irregularity in how I represent state (for memory, calldata and storage I use EVM-level primitives.)
41    1. Add my own scope view classes  
42    2. Add my own SingleByteLocal class
43    3. Use those...?
44    4. Fix evalLV's IndexAccess case to use those
45 - Refactor eval to only handle PrimitiveValue
46 - Refactor localscope to only hold PrimitiveValue
47 - get test for OoO for index access to run
48 - figure out why TF is isPointerValue broken (maybe just re-release?) and then fix:
49 - COMMIT & mail progress
50 - add test for OoO for tuples
51 - add test for OoO for tuple assignments
52 - add test for OoO for binary ops
53 - add if
54 - add while
55 - continue
56 - break
57 - add for
58 - remove the localsStack from state. Its unnecessary. The store can live inside of LocalScope
59 - implement member access (minus builtins)
60 - add (basic) member access tests
61 - add array literals
62 - TF - fix flow to work with local dep on sol-dbg
63 - fix bug in PointerMemView.encode
64 - !!add copy logic to assignment!!
64    - make sure it works with implicit assignments - calls, returns, variable declaration statements
65    - nested array bug?
66    - impl evalLV for member access
67 - implement struct constructor

68 - add match
69 - add evalC
70 - go over eval uses and replace with evalC wherever appropriate
71 - convert eval to NonPoisonValue
72 - remove unnecessary expects
73 - add node stack and move trace to Interpreter
74 - add them to InterpError(s)
75 - pp the whole trace
76 - get MemoryAliasing to work
77 - start StorageAliasing
78 - fix local copy semantics
79 - implement maps
80 - add a test with maps to verify that we check strings by value
81 - handle missing fieldName(s)
82 - add test with maps in mem structs and struct constructor
83 - add test with maps in mem structs and assignments storage->mem, mem->mem, mem->storage
84 - add ctx to InterpError to allow easier tracing of errors.

- add test with struct constructor and out-of-order field names, and mutation to capture order of execution
- add a test with array of maps in a struct and push

- jest debug config
- fix my lint on save to:
    - not do small shitty changes in sol-dbg repo
    - actuall remove unused imports ffs

// ---------------
- add internal calls
- add evalNew
- add modifiers
- more coercions
- cli for playing
- plan external calls, try/catch etc...
- add builtins


- make a pass to remove nyi and todos
- add side-by-side execution test :)
- refactor this.expect to use template strings like sol.assert as an optimization

Eventually:
    - cleanup nyi()s to 0
    - doc all functions
    - cleanup @todo-s
    - cli

Writing ideas:
    - the design choice of producing a high-level trace opens up the possibilities for establishing bisimulations!!
