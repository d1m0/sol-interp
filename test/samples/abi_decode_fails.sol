pragma solidity 0.8.29;

contract Foo {
    function tryDecode(bytes memory bs) external returns (uint, uint) {
        return abi.decode(bs, (uint, uint));
    }

    function main() public {
        uint a;
        uint b;

        (a, b) = this.tryDecode(hex"00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000006");
        assert(a == 5 && b == 6);
        try this.tryDecode(hex"000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000") {
            assert(false);
        } catch (bytes memory errData) {
            assert(errData.length == 0);
        }
    }
}
