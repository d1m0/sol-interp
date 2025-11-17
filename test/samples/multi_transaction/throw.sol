pragma solidity 0.4.24;

contract Child {
    function fail() public {
        throw;
    }
}

contract Foo {
	function main() public {
        Child c = new Child();

        bytes memory data = abi.encodeWithSelector(0xa9cc4718);
        bool res = address(c).call(data);
        assert(!res);
	}
}