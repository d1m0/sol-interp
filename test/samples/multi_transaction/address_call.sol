pragma solidity 0.8.29;

contract Child {
    constructor() public payable {
        assert(address(this).balance == 3);
    }

    function addAndGetMoney(uint x, uint y) public payable returns (uint) {
        return x + y;
    }
}

contract Foo {
    constructor() public payable {}
	function main() public {
        Child c = new Child{value:3}();

        assert(address(c).balance == 3);

        bytes memory data = abi.encodeCall(c.addAndGetMoney, (3, 4));
        (bool res, bytes memory retData) = address(c).call{value: 1}(data);
        assert(res);
        uint z = abi.decode(retData, (uint256));

        assert(z == 7);
        assert(address(c).balance == 4);
	}
}

