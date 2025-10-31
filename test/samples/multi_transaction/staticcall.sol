pragma solidity 0.8.29;

contract Child {
    function add(uint x, uint y) public view returns (uint) {
        return x + y;
    }

    function fail() public view returns (uint) {
        revert("msg");
    }
}

contract Child1 {
    uint z;

    function add(uint x, uint y) public returns (uint) {
        z = x + y;
        return z;
    }
}

contract Foo {
    function bytesEq(bytes memory b1, bytes memory b2) internal returns (bool) {
        if (b1.length != b2.length) {
            return false;
        }

        for (uint i = 0; i < b1.length; i++) {
            if (b1[i] != b2[i]) {
                return false;
            }
        }

        return true;
    }

	function main() public returns (bytes memory) {
        Child c = new Child();
        Child1 c1 = new Child1();

        bytes memory data = abi.encodeCall(c.add, (3, 4));
        (bool res, bytes memory retData) = address(c).staticcall(data);
        assert(res);
        uint z = abi.decode(retData, (uint256));

        assert(z == 7);

        // Staticcall a method that modifies state
        (res, retData) = address(c1).staticcall(data);
        assert(!res && retData.length == 0);
        

        data = abi.encodeCall(c.fail , ());
        (res, retData) = address(c).staticcall(data);
        assert(!res);
        assert(bytesEq(retData, hex"08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000036d73670000000000000000000000000000000000000000000000000000000000"));
	}
}