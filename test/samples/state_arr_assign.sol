pragma solidity 0.8.29;

contract Foo {
    struct S {
        uint[] b;
    }

    uint[] a;
    S s;
    uint[][] c;
    uint[2][] d;

    function main() public {
        a = [1,2,3];
        assert(a.length == 3 && a[0] == 1 && a[1] == 2 && a[2] == 3);
        // Type error. So only top-level arrays...
        // s = S([1,2,3]);
        c = [[1,2,3], [9,4,5]];
        assert(c.length == 2 && c[0].length == 3 && c[1].length == 3);
        assert(c[0][2] == 3 && c[1][0] == 9);
        d = [[1,4], [3,5]];
        assert(d.length == 2 && d[0].length == 2 && d[1].length == 2);
        assert(d[0][1] == 4 && d[1][0] == 3);
    }
}