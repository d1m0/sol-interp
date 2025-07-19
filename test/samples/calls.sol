pragma solidity 0.8.29;

contract Calls {
    function fib(uint x) public returns (uint) {
        if (x == 0) {
            return 0;
        }

        if (x == 1) {
            return 1;
        }

        return fib(x-1) + fib(x-2);
    }

    function swap(uint x, uint y) internal returns (uint z, uint w) {
        (z, w) = (y, x);
    }

    function main() public {
        uint t = fib(4);
        assert(t == 3);
        uint u;

        (t, u) = swap(1, 2);
        assert(t == 2 && u == 1);
    }
}
