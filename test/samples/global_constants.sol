pragma solidity 0.8.28;

uint constant x = 1;
uint constant y = x + 1;

string constant z = "ab";
bytes constant w = bytes(z);

contract Foo {
	function main() public {
		assert(x == 1);
		assert(y == 2);
		assert(w.length == 2 && w[0] == 0x61 && w[1] == 0x62);
	}
}
