pragma solidity 0.8.29;

contract __IRTest__ {
    function bar() public {

    }
    function main() public payable returns (uint, uint) {
        uint a = gasleft();
        this.bar();
        uint b = gasleft();
        return (a,b);
    }
}