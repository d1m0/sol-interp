pragma solidity 0.8.28;

contract __IRTest__ {
    function main() public payable {
        bytes memory m = this.foo(hex"01020304");
        assert(m.length == 0);
    }

    function foo(bytes calldata b) public returns (bytes calldata) {
        return b[b.length:];
    }
}
