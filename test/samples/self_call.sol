pragma solidity 0.8.28;

contract Foo {
	function add(uint x, uint y) public returns (uint) {
		return x + y;
	} 

	function swap(uint x, uint y) public returns (uint, uint) {
		return (y, x);
	}

	function main() public {
		uint z = this.add(1, 2);
		assert(z == 3);

		(uint a, uint b) = this.swap(5, 6);
		assert(a == 6 && b == 5);
	}
}
