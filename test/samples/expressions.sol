pragma solidity 0.8.29;

contract Expressions {
    uint256 public a = 1;
    int128 public b = -1;
    uint8 public c = 347376267711948586270712955026063723559809953996921692118372752023739388919808 / 115792089237316195423570985008687907853269984665640564039457584007913129639936;
    bool public d = true;
    bool public e = !false;
    int16 public f = ~1;

    function main(uint arg) public returns (uint ret) {
        uint msg;
        {
            uint arg = a + 1;
            ret = d && e ? a == 1 ? (a + 1) * 2 * (a + 1) : 0 : 0;
        }
    }

    struct S {
        uint x;
        bool b;
    }

    struct S1 {
        S[] s;
    }

    uint[4] arr;
    S s;
    S1 s1;

    function foo() public {
        arr[3];
        s.x;
        s.b;
        s1.s[0].x;
        [1,2,3];
        [[1,2],[3,4]];
        return;
    }
}