pragma solidity 0.8.29;

contract Child {
    uint x;

    constructor() public {
    }

    function add(uint x, uint y) public view returns (uint) {
        return x + y;
    }

    function fail() public view {
        revert("msg");
    }

    function modState(uint t) public {
        x = t;
    }
}

contract Foo {
    uint t;
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
        Child c = new Child();
        
        bytes memory data = abi.encodeCall(c.add, (3, 4));
        (bool res, bytes memory retData) = address(c).delegatecall(data);
        assert(res);
        uint z = abi.decode(retData, (uint256));

        assert(z == 7);
        
        data = abi.encodeCall(c.fail , ());
        (res, retData) = address(c).delegatecall(data);
        assert(!res);
        assert(bytesEq(retData, hex"08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000036d73670000000000000000000000000000000000000000000000000000000000"));

        assert(t == 0);
        data = abi.encodeCall(c.modState, (5));       
        (res, retData) = address(c).delegatecall(data);
        assert(res);
        assert(t == 5);
	}
}