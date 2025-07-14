pragma solidity 0.8.29;

contract OoO {
    function assignmentOOO() public returns (bytes memory, uint8) {
        uint8 x = 1;
        bytes memory b = hex"00000000000000000000";

        // If base is first, then we will assign 2 to b[1]
        // If base is second, we will assign 1 to b[2]
        b[x++] = bytes1(x++);
        assert(b[2] == 0x01);
        return (b, x);
    }

    function indexAccess() public {
        uint[4][4] memory x;
        uint i = 1;

        // If base executes first, we will assign to x[1][2]
        // If index executes first, we will assign to x[2][1]
        x[i++][i++] = 1;
        assert(x[1][2] == 1 && x[2][1] == 0);
    }
}