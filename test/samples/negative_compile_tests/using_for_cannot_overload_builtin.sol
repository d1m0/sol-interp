pragma solidity 0.8.29;

library Lib {
    function call(address a, bytes memory b) public returns (bool, bytes memory) {
        (bool res,) = a.call(b);

        return (res, hex"deadbeef");
    }

    function boo(Foo f) public returns (uint) {
        return 2;
    }
}

contract Foo {
    using { Lib.call } for address;
    using { Lib.boo } for Foo;

    function boo() public returns (uint) {
        return 2;
    }

    function foo() public returns (uint) {
        return 42;
    }

    function main() public {
        // won't compile - callable not unique - cannot override builtin
        address(this).call(hex"");
        // won't compile - callable not unique - cannot override method
        // this.boo();
    }
}
