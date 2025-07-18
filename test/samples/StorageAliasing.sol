pragma solidity 0.4.24;

contract StorageAliasing {
    uint[4] a1;
    uint[4] a2;
    
    function arrays() public {
        uint[4] storage x = a1;
        uint[4] storage y = a2;
        
        assert(x[0] == 0 && x[1] == 0 &&x[2] == 0 &&x[3] == 0);
        assert(y[0] == 0 && y[1] == 0 &&y[2] == 0 &&y[3] == 0);
        // Heap before
        //  a1
        //    \
        //      [0,0,0,0]
        //    /
        //  x 
        //
        //  a2
        //    \
        //      [0,0,0,0]
        //    /
        //  y 
        //
        x[0] = 42;
        // Heap after
        //  a1
        //    \
        //      [42,0,0,0]
        //    /
        //  x 
        //
        //  a2
        //    \
        //      [0,0,0,0]
        //    /
        //  y 
        //
        assert(x[0] == 42 && y[0] == 0 && a1[0] == 42 && a2[0] == 0);
        x = y;
        // Heap after
        //  a1 - [42,0,0,0]
        //
        //  a2
        //    \
        //  y-  [0,0,0,0]
        //    /
        //  x 

        assert(x[0] == 0 && y[0] == 0 && a1[0] == 42);
        x[0] = 43;
        // Heap after
        //  a1 - [42,0,0,0]
        //
        //  a2
        //    \
        //  y-  [43,0,0,0]
        //    /
        //  x 
        assert(x[0] == y[0]);
        assert(x[0] == 43 && y[0] == 43 && a1[0] == 42 && a2[0] == 43);
    }
    
    struct ArrStruct {
        uint[4] arr;
    }
    
    ArrStruct s1;
    ArrStruct s2;
    
    function arraysInStructs() public {
        ArrStruct storage x = s1;
        ArrStruct storage y = s2;
        
        assert(x.arr[0] == 0 && x.arr[1] == 0 &&x.arr[2] == 0 &&x.arr[3] == 0);
        assert(y.arr[0] == 0 && y.arr[1] == 0 &&y.arr[2] == 0 &&y.arr[3] == 0);
        // Heap before
        //  s1
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  x 
        //
        //  s2
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  y 
        //
        x.arr[0] = 42;
        // Heap after
        //  s1
        //    \
        //      { arr: [42,0,0,0] }
        //    /
        //  x 
        //
        //  s2
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  y 
        //
        assert(x.arr[0] == 42 && s1.arr[0] == 42 && y.arr[0] == 0 && s2.arr[0] == 0);
        x.arr = y.arr;
        // Heap after. NOTE THIS BEHAVIOR IS DIFFERENT IF STRUCTS WERE LOCATED IN MEMORY
        //  a1
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  x 
        //
        //  a2
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  y 
        //
        assert(x.arr[0] == 0 && s1.arr[0] == 0 && y.arr[0] == 0 && s2.arr[0] == 0);
        x.arr[0] = 43;
        // Heap after.
        //  a1
        //    \
        //      { arr: [43,0,0,0] }
        //    /
        //  x 
        //
        //  a2
        //    \
        //      { arr: [0,0,0,0] }
        //    /
        //  y 
        //
        assert(x.arr[0] != y.arr[0]);
        assert(x.arr[0] == 43 && s1.arr[0] == 43 && y.arr[0] == 0 && s2.arr[0] == 0);
    }
    
    struct Foo {
        uint x;
    }
    mapping(uint => Foo) m;
    Foo f;
    
    function maps() public {
        // Heap before.
        // m -> <{ }>
        m[0] = Foo({x: 1});
        // Heap after.
        // m -> <{ 0: { x: 1} }>
        m[1] = Foo({x: 2});
        // Heap after.
        // m -> <{ 0: { x: 1} 1: { x: 2} }>
        
        m[2] = m[0];
        // Heap after.
        // m -> <{ 0: { x: 1} 1: { x: 2} 2: { x: 1 } }>
        assert(m[0].x == 1 && m[2].x == 1);
        m[2].x = 3;
        // Heap after.
        // m -> <{ 0: { x: 1} 1: { x: 2} 2: { x: 3 } }>
        assert(m[2].x != m[0].x);
        assert(m[2].x == 3 && m[0].x == 1);
        
        // Memory->storage variable->mapping
        Foo memory b;
        b.x = 43;
        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 1} 1: { x: 2} 2: { x: 3 } }>
        //
        // MEMORY:
        // b -> { x: 43}
        m[0] = b;

        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 43} 1: { x: 2} 2: { x: 3 } }>
        //
        // MEMORY:
        // b -> { x: 43}
        assert(m[0].x == 43 && b.x == 43);
        m[0].x = 42;
        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 42} 1: { x: 2} 2: { x: 3 } }>
        //
        // MEMORY:
        // b -> { x: 43}
        assert(m[0].x != b.x);
        assert(m[0].x == 42 && b.x == 43);
        
        Foo storage b1 = f;
        b1.x = 44;
        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 42} 1: { x: 2} 2: { x: 3 } }>
        //
        // b1
        //   \
        //    { x: 44 }
        //   /
        // f
        assert(b1.x == 44 && f.x == 44);
        
        m[0] = b1;
        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 44} 1: { x: 2} 2: { x: 3 } }>
        //
        // b1
        //   \
        //    { x: 44 }
        //   /
        // f
        assert(m[0].x == 44 && b1.x == 44 && f.x == 44);
        
        m[0].x = 45;
        // Heap after.
        // STORAGE:
        // m -> <{ 0: { x: 45} 1: { x: 2} 2: { x: 3 } }>
        //
        // b1
        //   \
        //    { x: 44 }
        //   /
        // f
        assert(m[0].x != b1.x);
        assert(m[0].x == 45 && b1.x == 44 && f.x == 44);
    }
    
    struct Inner {
        uint x;
    }
    
    struct Outer {
        uint y;
        Inner inner;
    }
    
    Outer os1;
    Outer os2;
    
    
    function structInStructCopy() public {
        os1.y = 1;
        os1.inner.x = 42;
        
        os2.y = 2;
        os2.inner.x = 43;
        
        os1.inner = os2.inner;
        assert(os1.inner.x == 43 && os2.inner.x == 43);    
        
        os1.inner.x = 50;
        assert(os1.inner.x == 50 && os2.inner.x == 43);    
    }
}