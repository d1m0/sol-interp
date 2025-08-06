pragma solidity 0.8.28;

contract Foo  {
    struct F {
        uint a;
        uint b;
    }

    function getF() internal returns (F memory) {
    }

    function main() public {
        F memory f1 = getF();
        F memory f2 = getF();

        f1.a = 1;
        f2.a = 2;
        assert(f1.a == 1 && f2.a == 2);
    }
}
