pragma solidity 0.8.29;

contract Child {}

contract Boo {
    function makeChild() public returns (address) {
        return address(new Child());
    }


    function ping() public {}
}

contract Foo {
    function main() public returns (address) {
        Boo b = new Boo();
        // Nonce is 1

        // The below 2 blocks should return the same address

        bytes memory data = abi.encodeCall(b.makeChild, ());
        // Next call increments nonce to 2 before the creation of Child
        (bool res, bytes memory retData) = address(b).delegatecall(data);
        (address a) = abi.decode(retData, (address));
        return a;

        //bytes memory data = abi.encodeCall(b.ping, ());
        //address(b).delegatecall(data);
        // Nonce is now 2
        // return address(new Child());
    }
}
