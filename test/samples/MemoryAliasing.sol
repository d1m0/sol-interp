pragma solidity 0.4.24;

contract MemoryAliasing {
    function primitiveValuesDontAlias() public {
        uint x = 1;
        uint y = 2;
        x = y;
        x = 3;
        assert(y == 2);
    }

    function arrays() public {
        uint[4] memory a = [uint(1),2,3,4];
        // Before heap looks like: 
        //     a -> [1,2,3,4]
        uint[4] memory b = a;
        // After heap looks like: 
        //     a -> [1,2,3,4]
        //          /
        //     b --/

        b[0] = 42;
        // After heap looks like: 
        //     a -> [42,2,3,4]
        //          /
        //     b --/
        assert(a[0] == b[0]);
        assert(a[0] == 42);
    }
    
    function nestedArrays() public {
        uint[3][2] memory a = [[uint(1),2,3], [uint(4),5,6]];
        // Before heap looks like: 
        //     a -> [
        //            ->   [1,2,3]
        //            ,
        //            ->   [4,5,6]
        //          ]
        
        a[0] = a[1];
        assert(a[0][0] == 4 && a[1][0] == 4);
        
        a[0][0] = 42;
        assert(a[0][0] == 42 && a[1][0] == 42);
    }

    
    function structs() public {
        // Uninitialized local struct vars are implicitly allocated and zero-filled
        Foo memory x1;
        Foo memory x2;
        
        assert(x1.x == 0 && x2.x == 0);
        // Before heap looks like: 
        //     x1 -> { x: 0, arr: [0,0,0,0] }
        //     x3 -> { x: 0, arr: [0,0,0,0] }
        x1.x = 1;
        // After heap looks like: 
        //     x1 -> { x: 0, arr: [0,0,0,0] }
        //     x3 -> { x: 1, arr: [0,0,0,0] }
        assert(x1.x == 1 && x2.x == 0);
        
        Foo memory a;
        a.x = 43;
        a.arr = [uint(1),2,3,4];
        // Before heap looks like: 
        //     a -> { x: 43, arr: [1,2,3,4] }
        Foo memory b = a;
        // After heap looks like: 
        //     a -> { x: 43, arr: [1,2,3,4] }
        //          /
        //     b --/
        b.arr[0] = 42;
        // After heap looks like: 
        //     a -> { x: 43, arr: [42,2,3,4] }
        //          /
        //     b --/
        assert(a.arr[0] == b.arr[0]);
        assert(a.arr[0] == 42);
        b.x = 42;
        // After heap looks like: 
        //     a -> { x: 42, arr: [42,2,3,4] }
        //          /
        //     b --/
        assert(a.x == b.x);
        assert(a.x == 42);
    }
    
    struct Foo {
        uint x;
        uint[4] arr;
    }
    
    Foo sa;
    Foo sb;
    
    function arraysInMemoryStructs() public returns (uint[4] memory, uint[4] memory) {
        Foo memory a;
        a.arr = [uint(1),2,3,4];
        Foo memory b;
        b.arr = [uint(5), 5, 6, 8];

        assert(b.arr[0] == 5);
        // Before heap looks like: 
        //     a -> { x: 0, arr: [1,2,3,4] }
        //     b -> { x: 0, arr: [5,6,7,8] }
        b.arr = a.arr;
        // After heap looks like: 
        //     a -> { x: 0, arr }
        //                    \        
        //                     [1,2,3,4]
        //                    /
        //     b -> { x: 0, arr }
        assert(b.arr[0] == 1 && b.arr[1] == 2 && b.arr[2] == 3 && b.arr[3] == 4);
        b.arr[0] = 42;
        // After heap looks like: 
        //     a -> { x: 0, arr }
        //                    \        
        //                     [42,2,3,4]
        //                    /
        //     b -> { x: 0, arr }
        assert(b.arr[0] == a.arr[0]);
        assert(a.arr[0] == 42);
        

        a.arr[1] = 80;
        // After heap looks like: 
        //     a -> { x: 0, arr }
        //                    \        
        //                     [42,80,3,4]
        //                    /
        //     b -> { x: 0, arr }
        assert(b.arr[1] == a.arr[1]);
        assert(b.arr[1] == 80);
        return (a.arr, b.arr);
    }
    
    struct Bar {
        uint x;
    }
    
    struct Boo {
        uint y;
        Bar b;
    }
    
        
    function structInMemoryStructs() public {
        Boo memory a;
        a.y = 1;
        a.b.x = 2;
        Boo memory b;
        b.y = 3;
        b.b.x = 4;
        
        assert(b.y == 3);
        assert(b.b.x  == 4);
        
        // Before heap looks like: 
        //     a -> { y: 1, b: { x: 2} }
        //     b -> { y: 3, b: { x: 4 } }
        b.b = a.b;
        // After heap looks like: 
        //     a -> { y: 1, b }
        //                    \        
        //                     { x: 2 }
        //                    /
        //     b -> { y: 3, b }
        assert(b.y == 3);
        assert(a.y == 1);
        assert(b.b.x  == 2);

        b.b.x = 42;
        // After heap looks like: 
        //     a -> { y: 1, b }
        //                    \        
        //                     { x: 42 }
        //                    /
        //     b -> { y: 3, b }
        assert(a.b.x == b.b.x);
        assert(a.b.x == 42);
        a.b.x = 80;
        // After heap looks like: 
        //     a -> { y: 1, b }
        //                    \        
        //                     { x: 80 }
        //                    /
        //     b -> { y: 3, b }
        assert(a.b.x == b.b.x);
        assert(b.b.x == 80);
    }
    
    function structsInMemoryArrays() public {
        Boo[4] memory a;
        
        a[0].y = 1;
        a[0].b.x = 2;
        a[1].y = 3;
        a[1].b.x = 4;
        
        assert(a[0].y == 1);
        assert(a[0].b.x == 2);
        // Before heap looks like: 
        //     a[0] -> { y: 1, b: { x: 2} }
        //     a[1] -> { y: 3, b: { x: 4 } }
        a[0] = a[1];
        // After a[0] and a[1] alias. Heap looks like: 
        //  a[0] \
        //         { y: 3, b: { x: 4} }
        //  a[1] /

        assert(a[0].y == 3);
        assert(a[0].b.x == 4);
        // Aliasing between two entries in an array
        a[0].y = 42;
        // After heap looks like: 
        //  a[0] \
        //         { y: 42, b: { x: 4} }
        //  a[1] /
        assert(a[0].y == a[1].y);
        assert(a[1].y == 42);
        assert(a[1].b.x == 4);
        assert(a[0].b.x == 4);
        a[1].b.x = 43;
        // After heap looks like: 
        //  a[0] \
        //         { y: 42, b: { x: 43} }
        //  a[1] /
        assert(a[1].b.x == a[0].b.x);
        assert(a[0].b.x == 43);
        
        // 2-level aliasing - add another memory struct of type Bar
        Bar memory b;
        b.x = 123;
        
        // Before heap looks like: 
        //  a[0] \
        //         { y: 42, b: { x: 43} }
        //  a[1] /
        //
        //  b -> { x: 123 }
        a[0].b = b;
        // After heap looks like: 
        //  a[0] \
        //         { y: 42, b: -> { x: 123 } }
        //  a[1] /               /
        //                      /
        //  b -----------------
        
        
        assert(a[0].b.x == b.x);
        assert(a[0].b.x == 123);
        assert(a[1].b.x == 123);
        
        b.x = 112233;
        // After heap looks like: 
        //  a[0] \
        //         { y: 42, b: -> { x: 112233 } }
        //  a[1] /               /
        //                      /
        //  b -----------------
        assert(a[0].b.x == b.x);
        assert(a[0].b.x == 112233);
        assert(a[1].b.x == 112233);
        

        
        a[2].y = 1;
        a[2].b.x = 2;
        a[3].y = 3;
        a[3].b.x = 4;
        // Aliasing between structs nested inside different entries in the array
        // Before heap looks like:
        //     a[2] -> { y: 1, b: { x: 2} }
        //     a[3] -> { y: 3, b: { x: 4 } }
        a[2].b = a[3].b;
        // After heap looks like:
        //     a[2] -> { y: 1, b: }
        //                       \
        //                        { x: 4 }
        //                       /
        //     a[3] -> { y: 3, b: }
        assert(a[2].b.x == a[3].b.x);
        assert(a[2].y == 1);
        assert(a[3].y == 3);
        assert(a[2].b.x == 4);
        assert(a[3].b.x == 4);
        
        a[2].b.x = 42;
        // After heap looks like:
        //     a[2] -> { y: 1, b: }
        //                       \
        //                        { x: 42 }
        //                       /
        //     a[3] -> { y: 3, b: }
        assert(a[2].b.x == a[3].b.x);
        assert(a[3].b.x == 42);
    }
    
    function structReAssignment() public {
        Foo memory a;
        // After heap looks like: 
        //     a -> { x: 0, arr: [0,0,0,0] }

        Foo memory b = a;
        // After heap looks like: 
        //     a -> { x: 0, arr: [0,0,0,0] }
        //          /
        //     b --/
        
        a.x = 42;
        // After heap looks like: 
        //     a -> { x: 42, arr: [0,0,0,0] }
        //          /
        //     b --/
        a.arr[0] = 43;
        // After heap looks like: 
        //     a -> { x: 42, arr: [43,0,0,0] }
        //          /
        //     b --/
        
        assert(b.x == 42 && b.arr[0] == 43);
        a = Foo({x: 1, arr: [uint(1),2,3,4]});
        // After heap looks like: 
        //     a -> { x: 1, arr: [1,2,3,4] }
        //          
        //     b -> { x: 42, arr: [43,0,0,0] }
        
        assert(a.x == 1 && a.arr[0] == 1);
        assert(b.x == 42 && b.arr[0] == 43);
    }
    
    
    Foo sfoo;
    
    function structReAssignmentFromStorage() public {
        Foo memory a;
        // After heap looks like: 
        //     a -> { x: 0, arr: [0,0,0,0] }
        Foo memory b = a;
        // After heap looks like: 
        //     a -> { x: 0, arr: [0,0,0,0] }
        //          /
        //     b --/
        
        a.x = 42;
        // After heap looks like: 
        //     a -> { x: 42, arr: [0,0,0,0] }
        //          /
        //     b --/

        a.arr[0] = 43;
        // After heap looks like: 
        //     a -> { x: 42, arr: [43,0,0,0] }
        //          /
        //     b --/
        
        assert(b.x == 42 && b.arr[0] == 43);
        sfoo = Foo({x: 1, arr: [uint(1),2,3,4]});
        // After heap looks like: 
        //     a -> { x: 42, arr: [43,0,0,0] }
        //          /
        //     b --/
        // ==== STORAGE MEMORY ===
        //     sfoo ->  { x: 1, arr: [1,2,3,4] }
        a = sfoo;
        // After heap looks like: arraysInMemoryStructs
        //     a -> { x: 1, arr: [1,2,3,4] }
        //          
        //     b -> { x: 42, arr: [43,0,0,0] }
        // ==== STORAGE MEMORY ===
        //     sfoo ->  { x: 1, arr: [1,2,3,4] }
        
        assert(a.x == 1 && a.arr[0] == 1);
        assert(b.x == 42 && b.arr[0] == 43);
        assert(sfoo.x == 1 && sfoo.arr[0] == 1);
        a.x=50;
        // After heap looks like: 
        //     a -> { x: 50, arr: [1,2,3,4] }
        //          
        //     b -> { x: 42, arr: [43,0,0,0] }
        // ==== STORAGE MEMORY ===
        //     sfoo ->  { x: 1, arr: [1,2,3,4] }
        assert(a.x == 50 && a.arr[0] == 1);
        assert(b.x == 42 && b.arr[0] == 43);
        assert(sfoo.x == 1 && sfoo.arr[0] == 1);
    }

   mapping(uint=>uint) m;
   mapping(uint=>uint) m1;
   struct MapStruct {
       mapping(uint=>uint) m;
   }
   MapStruct ms;
   
   function copyMap() public {
       // For completeness sake evidence that we can't copy mappings.
       m[0] = 1;
       assert(m[0] == 1 && ms.m[0] == 0);
       
       // Causes a type error - mappings cannot be assigned to.
       //ms.m = m;
       // Causes a type error - mappings cannot be assigned to.
       //m1 = m;
   }
   
}