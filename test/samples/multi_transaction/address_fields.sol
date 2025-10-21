pragma solidity 0.8.28;

contract Foo {
    constructor() payable {
        assert(address(this).code.length == 0);
        assert(address(this).codehash == 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470);
    }

    function code() public returns (bytes memory) {
        return address(this).code;
    }

    function codehash() public returns (bytes32) {
        return address(this).codehash;
    }

    function balance() public returns (uint) {
        return address(this).balance;
    }
}
