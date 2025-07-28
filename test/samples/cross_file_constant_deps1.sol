pragma solidity 0.8.28;
import {Foo} from "cross_file_constant_deps2.sol";

uint constant y = Foo.u + 1;

uint constant x = 1;

string constant f = "abcde";
bytes constant g = hex"010203040506";

contract Main {
    function main() public {
        assert(x == 1);
        assert(Foo.t == 2);
        assert(Foo.u == 3);
        assert(y == 4);
        assert(g[0] == bytes1(0x01));
    }
}