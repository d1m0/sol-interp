pragma solidity 0.8.28;

contract DecodingTest {
    function testBools() internal pure {
        (bool a, bool b) = abi.decode(abi.encode(true, false), (bool, bool));

        assert(a == true);
        assert(b == false);
    }

    function testByte1() internal pure {
        bytes1 x = abi.decode(abi.encode(bytes1(0x01)), (bytes1));

        assert(x == 0x01);
    }

    function testByte32() internal pure {
        bytes32 x = abi.decode(
            abi.encode(
                bytes32(
                    0x0102030405060708091011121314151617181920212223242526272829303132
                )
            ),
            (bytes32)
        );

        assert(
            x ==
                0x0102030405060708091011121314151617181920212223242526272829303132
        );
    }

    function testInts() internal pure {
        (int256 a, uint256 b) = abi.decode(
            abi.encode(-123, 123),
            (int256, uint256)
        );

        assert(a == -123);
        assert(b == 123);
    }

    function testAddress() internal pure {
        address x = abi.decode(
            abi.encode(address(0xc03c4bF79eB0a0fD5fB75C35AddA741BC90Cf6b4)),
            (address)
        );

        assert(x == 0xc03c4bF79eB0a0fD5fB75C35AddA741BC90Cf6b4);
    }

    function testString() internal pure {
        string memory x = abi.decode(abi.encode("tesT"), (string));

        assert(bytes(x)[0] == bytes1("t"));
        assert(bytes(x)[1] == bytes1("e"));
        assert(bytes(x)[2] == bytes1("s"));
        assert(bytes(x)[3] == bytes1("T"));
    }

    // Fails to desugar
    function testUintFixedArray() internal pure {
        uint256[3] memory x = abi.decode(
            abi.encode([uint256(1), 2, 3]),
            (uint256[3])
        );

        assert(x[0] == 1);
        assert(x[1] == 2);
        assert(x[2] == 3);
    }

    struct Point {
        uint16 x;
        uint16 y;
    }

    function testStruct() internal pure {
        Point memory p1 = Point(13, 14);

        Point memory p2 = abi.decode(abi.encode(p1), (Point));
        assert(p2.x == p1.x && p2.y == p1.y);

        (uint256 x, uint256 y) = abi.decode(abi.encode(p1), (uint, uint));

        assert(x == p1.x && y == p1.y);
    }

    function testTuples() internal pure {
        //Fails: Apparently nested tuples are not allowed
        //abi.encode(uint32(1), int16(-1), true, (uint256(1), uint256(2)), bytes(hex"01020304"));
    }

    function test() public {
        testBools();
        testByte1();
        testByte32();
        testInts();
        testAddress();
        testString();
        testUintFixedArray();
        testStruct();
    }
}
