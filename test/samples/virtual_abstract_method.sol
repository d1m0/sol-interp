pragma solidity 0.8.28;

abstract contract Base {
    function foo(uint x) public virtual returns (uint);
    function bar(uint x) public returns (uint) {
        return 1 + foo(x);
    }
}

contract Child is Base {
    function foo(uint x) public virtual override returns (uint) {
        return x*2;
    }

    function main() public {
        assert(bar(5) == 11);
    }
}
