pragma solidity 0.8.28;

abstract contract Base {
    uint x;

    modifier M() virtual;
    function foo() M() public returns (uint) {
        return x;
    }
}

contract Child is Base {
    modifier M() virtual override {
        x = 42;
        _;
    }

    function main() public {
        assert(42 == foo());
    }
}
