pragma solidity 0.8.28;

contract Foo {
    function getLenCD(bytes calldata s) public returns (uint) {
        return s.length;
    }

    function getLenMem(bytes memory s) public returns (uint) {
        return s.length;
    }

    function setByteCD(bytes calldata b, uint idx, bytes1 newB) public returns (bytes memory) {
        bytes memory memB = b;
        memB[idx] = newB;
        return memB;
    }

    function setByteMem(bytes memory b, uint idx, bytes1 newB) public returns (bytes memory) {
        b[idx] = newB;
        return b;
    }
}
