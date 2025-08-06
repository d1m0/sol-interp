pragma solidity 0.8.28;

contract Foo {
    function foo(uint256 a, bytes2 b, bytes memory c) internal {
        assert(c.length == 2);
        assert(a == 1);
        assert(b == 0x0102);
    }

    function retStorBytes() internal returns (bytes storage) {
        return sB;
    }

    function checkMemBytes(bytes memory m) internal {
        assert(m.length == 2 && m[1] == 0x02);
    }
        
    bytes sB;

    function main() public {
        sB = hex"0102";
        foo(1, 0x0102, sB);

        bytes memory mB = retStorBytes();
        assert(mB.length == 2 && mB[1] == 0x02);

        checkMemBytes(retStorBytes());
    }
}
