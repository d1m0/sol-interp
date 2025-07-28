pragma solidity 0.8.28;

contract Foo {
    function main() public {
        uint16 x = 0x0102;

        bytes2 bx = bytes2(x);
        assert(bx == 0x0102);

        bx = 0x0304;
        assert(bx == 0x0304);

        // Cant seem to get negative literals to cast to bytes
        //bx = -0x00102;
        //bx = -1;
        //bx = int16(-1);
        bx = -0; // except -0
        assert(bx == 0x0000);
    }

    function binops() internal {
        bytes2 b = 0x0102;
        assert(b == 0x0102);

        assert(b < 0x0103);
        assert(b > 0x0101);
    }
}
