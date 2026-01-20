pragma solidity 0.6.4;

contract Delete {
    uint sA;
    bytes2 sB;
    bytes sC;
    uint[] sD;

    struct S {
        uint a;
        uint b;
    }

    S sE;

    mapping (uint => uint) sM;

    struct SM {
        uint a;
        mapping (uint => uint) m;
    }

    SM sF;

    function main() public {
        uint a = 1;
        delete a;
        assert(a == 0);
        bool b = true;
        delete b;
        assert(b == false);
        bytes3 c = 0x010203;
        delete c;
        assert (c == 0x000000);
        bytes memory d = hex"deadbeef";
        delete d;
        assert(d.length == 0);
        
        sA = 1;
        delete sA;
        assert(sA == 0);
        sB = 0x0102;
        delete sB;
        assert(sB == 0x0000);
        sC = hex"deadbeef";
        delete sC;
        assert(sC.length == 0);
        sD = [1,2,3];
        delete sD;
        assert(sD.length == 0);
        sE = S(42, 43);
        assert(sE.a == 42 && sE.b == 43);
        delete sE;
        assert(sE.a == 0 && sE.b == 0);
        sM[0] = 1;
        // Compiler error to delete sM
        // delete sM;

        sF.a = 1;
        sF.m[0] = 1;

        delete sF;
        assert(sF.a == 0 && sF.m[0] == 1);

        SM memory e;
        e.a = 1;
        delete e;
        assert(e.a == 0);
    }
}
