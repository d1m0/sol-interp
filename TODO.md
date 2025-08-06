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
85 - add internal calls
86 - add length
87 - add evalNew for arrays
88 - emit
89 - start modifiers

90 - add a "constant" store in the state. Make it a memory to allow for bytes/string constants. Maybe move literals there as well!
91 - build constant evaluation graph
92    - for each cosntant vardecl
93        - walk over children, and for everything with a vReferenced declaration add a dependency
94 - do topoSort() of the constant vars over all units
95 - add a GlobalScope that knows about global vars. It has a map from name->astNode. Its lookup/lookupLocation just lookup the view in state.constantMap based on node id
96 - make a "createGlobalScope(unit)" -> GlobalScope
97 - add makeScope(node, state) -> scope where node in (SourceUnit, ContractDefinition, FunctionDefinition, BuiltinFunction, ModifierInvocation)
98 - make empty state
99 - for each var in the topoSort 
99    eval the init expression in makeScope(var.vScope, state) and set it

100 - subclass ArtifactManager
101 - add unit->ArtifactInfo mapping
102 - add getConstants(artifactInfo): Map<string, View>, memory
103 - move "gatherConstants" half-baked thing in there
104 - finish gatherConstants
105 - undo constants memory space
106 - get original tests to run

107 - ArrayLikeView interface should include pp()
108 - fix bug in PointerMemView.allocSize() for bytes/string
109 - or AstNode->Artifact and AstNode->ContractArtifact mapping?
110 - move getMemFor to PointerMemView
111 - expose Allocator.baseOffset()
112 - get test with only global consts to run
113 - fix nit in intrp.evalTypeConversion due to base being protected
114 - replace getTempMem with getMemFor and go through other uses of alloc
115 - add constant vars to ContractScope
116 - get test with contract constants to run
117 - add constants tests from other repo
118 - add a DefVal value
119 - add all defs to unit scope (minus struct/enum type defs)
120 - add all defs to contract scope (minus struct/enum type defs)
121 - add tests for Contract.Variable, Unit.Contract.Variable
122 - add test with AnotherContract.ConstantVariable and ThisContract.NonConstantVariable
123 - test repeated same modifier
124 - test modifier with return; in function with various returns
125 - add baseCall()
125    - save scope
125    - set new scope to makeScope(...)
125    - exec
125    - restore scope
125    - add test global calling a global
126 - test calling global from another file that references local global constants that are shadowed the cur scope
127 - test calling Library function from another file that depends on local globals and local constant contract vars that are shadowed in the cur scope
128 - test virtual abstract modifier
129 - test virtual abstract function
130 - merge & rel
131    - move version
132    - move artifact
133    - make infer a local var and kill this.infer()
134    - restore constantMap back to state
135    - remove state from where relevant
136 - make Interpreter artifact specific (i.e. move version, artifact and infer to it)
137 - add polymorphism
138 - add valueTypeOf
139 - check arg types on fun call/ret
140 - add array push builtin
141 - add option to take implicit this argument to builtinFunction
142 - Hit a bug around polymorphism and implicit casts. Implicit casts may involve copies (memory string literal -> storage). The correct order of operations is:
143    - get concrete builtin type
144    - assign args to go through casting/copy logic
145 - test push
146 - cleanup builtins - make them take their own scope with only other builtins
147 - add pop
148 - add concretize tests
149 - add union tests
150 - test pop

- check that normal internal calls handle arguments/returns assignment copies correctly
- Add a test with fun returning an uninitialized local struct
- builtins (nyi for anything needing external call state)

- add test with struct constructor and out-of-order field names, and mutation to capture order of execution
- migrate builtin tests
- units on literals

- Idea: Tying it all toghether at the top-level:
    - interface PersistentState {
        artifact: ArtifactInfo;
        mdc: ContractDefinition;
        storage: Storage;
        immutable: Memory;
        balance: bigint;
        ...
      }
    - World class has an ArtifactManager
        states: map<Address, PersistentState>
        makeCallState(msg: SolMessage) -> State
            - ai = states[msg.to]
            - construct memory and constant map from artifactManager.gatherConstants(ai)
            - fill out State - {intCallStack, scope,)
            
        makeCreateState(msg: SolMessage) -> State
            - nyi

    - Implement Interpreter.call
    - add `msg` builtin struct

    - add a full call test that accesses msg builtin

- Idea: remove reliance on solc-typed-ast's resolve:
    - add remaining named defs to global and struct scopes
    - update member access to handle Enum.Option

- add test notes from other branch
- add BaseWorld class that has an ArtifactManager

- need an "immutable" var space somewhere in the state

- make an exhaustive test for coercions from old code

// ---------------
- getters
    - test virtual function resolves to public getter
    - note - getters are only ever called externally :)
- external calls
- add evalNew for contracts
- more coercions
- cli for playing
- try/catch etc...
- add a test with array of maps in a struct and push

- make a pass to remove nyi and todos
- add side-by-side execution test :)
- refactor this.expect to use template strings like sol.assert as an optimization
- test behavior of zero-ing out (delete, assign zero, pop) of complex storage datastructures. Are they recursively zeroed-out? For sized arrays? For structs? for unsized arrays?

Eventually:
    - move push implementaion in ArrayStorageView/BytesStorageView
    - cleanup nyi()s to 0
    - doc all functions
    - cleanup @todo-s
    - cli

Writing ideas:
    - the design choice of producing a high-level trace opens up the possibilities for establishing bisimulations!!

Tried and failed:
- jest debug config