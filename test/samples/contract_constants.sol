pragma solidity 0.8.28;

contract Foo {
	uint public constant x = 1;
	uint public constant y = x + 1;

	string constant z = "ab";
	bytes constant w = bytes(z);

	uint s = 1;
	function main() public {
		assert(x == 1);
		assert(y == 2);
		assert(w.length == 2 && w[0] == 0x61 && w[1] == 0x62);

		assert(Foo.x == 1);
		assert(Foo.y == 2);
		assert(Foo.w.length == 2 && Foo.w[0] == 0x61 && Foo.w[1] == 0x62);

		assert(s == x);
		assert(Foo.s == Foo.x);
	}
}
