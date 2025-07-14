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

    function tuples() public returns (uint, uint) {
        uint x = 1;

        // If left-to-right should return 1, 2
        (uint y, uint z) = (x++, x++);
        return (y, z);
    }
    
    function tupleAssignments() public {
        uint[5] memory a;
        uint x = 1;

        // Expect rhs to evaluate first to (1,2)
        // Then LHS to evaluate to a[3], a[4], and thus to get
        // a === [0,0,0,1,2]
        (a[x++], a[x++]) = (x++, x++);
        assert(a[3] == 1 && a[4] == 2);
    }

    function binOps() public {
        uint[6] memory a;
        uint x = 0;
        // If LHS evaluates first we get [0,0,1,0,0,2]
        // If RHS evaluates first we get [0,0,0,2,0,1]
        (a[x+=2] = 1) + (a[x+=3] = 2);
        assert(a[3] == 2 && a[5] == 1); // RHS is first
    }
}