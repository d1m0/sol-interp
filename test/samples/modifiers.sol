pragma solidity 0.8.28;

contract Foo {
    uint t;
    modifier M2() {
        t = 5;
        _;
        t = 1;
    }

    function getT() M2() public returns (uint) {
        return t;
    }

    modifier M() {
        return;
        _;
    }

    uint f = 1;
    function foo() public M() returns (uint, bytes memory) {
        f = 2;
        return (1, hex"010203");
    }

    uint arrIdx = 0;
    uint[10] arr;

    modifier M1(uint z) {
        arr[arrIdx++] = z;
        _;
    }

    function bar(uint x) M1(x++) M1(x+=5) public returns (uint) {
        return x;
    }


    function main() public {
        // Simple modifier
        assert(t == 0);
        assert(getT() == 5);
        assert(t == 1);

        // Test return before body of function
        (uint x, bytes memory m) = foo();
        assert(x == 0 && m.length == 0);

        // Test order of evaluation of modifiers
        x = bar(1);
        assert(x == 7);
        assert(arrIdx == 2 && arr[0] == 1 && arr[1] == 7);

        // Test multiple placeholders and returning from another modifier
        assert(boo() == 4);
    }

    uint ctr = 0;
    modifier repeat(uint n) {
        for (uint i = 0; i < n; i++) {
            _;
        }
    }

    modifier incCtr() {
        ctr++;
        _;
    }

    modifier ifCtrGt(uint v) {
        if (ctr <= v) {
            return;
        }
        _;
    }

    function boo() repeat(4) incCtr() ifCtrGt(3) public returns (uint) {
        return ctr;
    }

/*
    Return args not allowed
    modifier M1() {
        return 1;
        _;
    }
*/
}
