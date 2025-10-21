pragma solidity 0.8.28;

library Lib {
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
    
    function checkAddressFields(uint balance, bytes memory code, bytes32 codeHash) external returns (bytes memory) {
        assert(address(this).balance == balance);
        assert(bytesEq(address(this).code, code));
        assert(address(this).codehash == codeHash);
    }
}

contract Foo {
    constructor() payable {
        Lib.checkAddressFields(13, hex"", 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470); 
    }

    function checkAddressFields(uint balance, bytes memory code, bytes32 hash) public returns (bytes memory) {
        Lib.checkAddressFields(balance, code, hash);
    }
}
