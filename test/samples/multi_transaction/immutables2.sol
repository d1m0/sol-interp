pragma solidity 0.8.29;
uint constant c = 1;

contract Foo {
    uint immutable a = 5;
    uint immutable b = a + c;
    uint immutable d;

    constructor() {
        a = a *2; //10
        b = b*2 + a; // 2*6 + 10 = 22;
        d = d + 1;
    }
    function foo() public returns (uint, uint, uint) {
        return (a,b,d);
    }

    function main() public {
        assert(a == 10);
        assert(b == 22);
        assert(d == 1);
    }
}
