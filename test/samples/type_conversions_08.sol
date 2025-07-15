pragma solidity 0.8.29;

contract Foo {
	function main() public {
		uint8(1);
		// Wont compile
        // uint8(256);
        unchecked {
            // Also wont compile
            // uint8(256);
        }
	}
}
