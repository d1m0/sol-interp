pragma solidity 0.8.29;

contract Child {
    constructor() public payable {
        assert(address(this).balance == 3);
    }

    function addAndGetMoney(uint x, uint y) public payable returns (uint) {
        return x + y;
    }

    function fail() public {
        revert("msg");
    }
}

contract Foo {
    constructor() public payable {}
    
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

	function main() public {
        Child c = new Child{value:3}();

        assert(address(c).balance == 3);

        bytes memory data = abi.encodeCall(c.addAndGetMoney, (3, 4));
        (bool res, bytes memory retData) = address(c).call{value: 1}(data);
        assert(res);
        uint z = abi.decode(retData, (uint256));

        assert(z == 7);
        assert(address(c).balance == 4);

        data = abi.encodeCall(c.fail , ());
        (res, retData) = address(c).call(data);
        assert(!res);
        assert(bytesEq(retData, hex"08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000036d73670000000000000000000000000000000000000000000000000000000000"));
	}
}