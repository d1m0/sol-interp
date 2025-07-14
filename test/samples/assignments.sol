pragma solidity 0.8.29;

contract Assignments {
    function simpleAssignment() public {
        int8 test = 1;
        assert(test == 1);
    }

    function multipleAssignmentsLong() public {
        int8 test = 2;
        int8 newTest = 1;

        assert(test == 2);
        assert(newTest == 1);

        test = test + 2;

        assert(test == 4);

        test = test - 2;

        assert(test == 2);

        test = test * 2;

        assert(test == 4);

        test = test / 2;

        assert(test == 2);

        test = test ** 2;

        assert(test == 4);

        test = test % 2;

        assert(test == 0);

        test = test | 1;

        assert(test == 1);

        test = test << 1;

        assert(test == 2);

        test = test >> 1;

        assert(test == 1);

        test = test & 0;

        assert(test == 0);

        test = test ^ 1;

        assert(test == 1);

        test = ~test;

        assert(test == -2);

        test = -test;

        assert(test == 2);

        newTest = test++;

        assert(test == 3);
        assert(newTest == 2);

        newTest = ++test;

        assert(test == 4);
        assert(newTest == 4);

        newTest = test--;

        assert(test == 3);
        assert(newTest == 4);

        newTest = --test;

        assert(test == 2);
        assert(newTest == 2);
    }

    function multipleAssignmentsShort() public {
        int16 test = 2;

        test++;

        assert(test == 3);

        ++test;

        assert(test == 4);

        test--;

        assert(test == 3);

        --test;

        assert(test == 2);

        test += 2;

        assert(test == 4);

        test -= 2;

        assert(test == 2);

        test *= 2;

        assert(test == 4);

        test /= 2;

        assert(test == 2);

        test %= 2;

        assert(test == 0);

        test <<= 1;

        assert(test == 0);

        test >>= 1;

        assert(test == 0);

        test |= 1;

        assert(test == 1);

        test &= 1;

        assert(test == 1);

        test ^= 1;

        assert(test == 0);
    }


    function tupleDeclaration() public {
        (uint8 r, uint16 t, string memory x) = (1, 2, "abc");
        (uint8 a, , string memory c, ) = (1, 2, "abc",4);
        assert(r == 1);
        assert(t == 2);
        assert(a == 1);
    }

    function tupleNested() public {
        uint8 r;
        uint16 t;
        string memory x;
        address f;
        address g;

        (r, t, (x, f)) = (3, 4, ("abc", g));
        assert(r == 3 && t == 4);
        (, t, (, f)) = (5, 6, ("def", g));
        assert(t == 6);
        (r, t, ,f) = (7, 8, ("xyz", 0x42), g);
        assert(r == 7 && t == 8);

        uint a = 0;
        // RValue expressions are evaluated even if there is no
        // corresponding LValue component to assignme them to.
        (uint b, uint c, ) = (0, 0, a = 42);
        assert (a == 42);
    }

    function tupleEvaluateAllInitialExpressions() public returns(uint){
        uint foo = 42;
        (uint8 a, , string memory c, ) = (1, foo=1337, "abc",4);
        assert(a == 1 && foo == 1337);
        return foo;
    }
}