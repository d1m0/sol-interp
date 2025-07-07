pragma solidity 0.8.29;

contract Foo {
    function sqr(uint x) public returns (uint y) {
        y = x * x;
    }

    function localVarScope() pure public returns (uint) {
        uint x = 1;
        uint z;
        {
            x = 2; // this will assign to the outer variable
            uint x;
            x = 3;
            z = x;
        }
        return x + z; // x has value 2
    }
}
