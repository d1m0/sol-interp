pragma solidity 0.4.24;

contract Ifs {
    
    function ifElseStatementNested() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 >= 2) {
            b = a / 4;
            if (b >= 2) {
                assert(false);
                b =  2;
            } else {
                a = a * 2;
            }
        } else {
            assert(false);
            b = a * 2;
        }

        b += 15;
        assert(b==15);
        assert(a==2);
    }

    function ifElseStatement() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 < 2) {
            assert(false);
            b = a / 2;
        } else {
            b = a * 2;
        }
        assert(b==2);
        b += 15;
        assert(b==17);
    }

    function ifStatement() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 >= 2) {
            b = a / 2;
        }
        
        assert(b==0);
        b += 15;
        assert(b==15);
    }

    function ifElseStatementWithExpressions() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 >= 2) b = a / 2;
        else b = a * 2;

        assert(b==0);
        b += 15;
        assert(b==15);
    }

    function ifStatementWithExpression() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 >= 2)b = a / 2;
        assert(b==0);
        b += 15;
        assert(b==15);
    }

    function ifStatementWithReturn() public {
        uint8 a = 1;
        uint8 b = 0;

        if (a + 1 >= 2)return;
        assert(false);
        b += 15;
    }

    function ifStatementWithThrow() public {
        uint8 a = 1;
        uint8 b = 42;

        if (a + 1 >= 2) {
            b = a*2;
        } else {
            revert();
        }

        assert(b==2);
        b += 15;
        assert(b==17);
    }    
}
