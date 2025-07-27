pragma solidity 0.8.28;
import * as consts from "global_constants.sol";
import * as consts2 from "lib.sol";
import "lib.sol";

contract Bar {
	uint x;

	function main() public {
		x = 1;
		uint y = Bar.x + consts.x;

		assert(y == 2);

		y = y + consts2.Lib.y;

		assert(y == 4);

		y = y + Lib.x;
		assert(y == 5);
	}
}
