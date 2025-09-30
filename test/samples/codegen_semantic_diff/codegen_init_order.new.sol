// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.29;

contract A {
    uint x;
    constructor() {
        x = 42;
    }
    function f() public view returns(uint256) {
        return x;
    }
}

contract Test is A {
    uint public y = f();
    function main() public {
        assert(y == 42);
    }
}


