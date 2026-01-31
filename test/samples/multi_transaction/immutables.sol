pragma solidity 0.8.29;

contract Foo {
    uint immutable a;
    uint constant d = 3;
    uint8 immutable b;
    constructor(uint x, uint8 y) {
        a = x + d;
        b = y;
    }

    function foo() public returns (uint) {
        return a + b;
    }

    function getCode() public returns (bytes memory) {
        return address(this).code;
    }
}

contract Bar {
    uint immutable x;
    uint8 constant y = 10;

    constructor(uint t) {
        x = t*2;
    }

    function main() public returns (uint, bytes memory) {
        Foo f = new Foo(x, y);
        uint z = f.foo();
        return (z, f.getCode());
    }
}