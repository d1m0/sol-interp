pragma solidity 0.8.29;

contract Foo {
    uint immutable a;
    uint8 immutable b;
    constructor(uint x, uint8 y) {
        a = x;
        b = y;
    }

    function foo() public returns (uint) {
        return a + b;
    }
}
