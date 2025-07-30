pragma solidity 0.8.28;
import { bar, Lib } from "global_fun_inc.sol";

bytes constant c = hex"010203";

function foo(uint x) returns (uint) {
    return bar(x);
}

contract Foo {
    string d = "abc";
    function main() public {
        assert(foo(1) == 5);
        assert(Lib.boo(1) == 10);
    }
}
