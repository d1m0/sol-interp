pragma solidity 0.8.29;

contract Foo {
    uint t = 1;
    modifier M(uint x) {
        t = x;
        _;
    }
    function boo(uint y) M(ret=y+3) public returns (uint ret) {
        ret += t;
    }

    function main() public {
        assert(boo(1) == 8);
    }
}
