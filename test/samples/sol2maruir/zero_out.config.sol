pragma solidity 0.8.29;

contract Foo {
    function id(uint i) internal returns (uint) {return i;}
    function eId(uint i) external returns (uint) {return i;}

    struct S {
        uint[] a;
        bytes b;
        bytes c;
        uint8[][] d;
        //function (uint i) internal returns (uint) id;
        function (uint i) external returns (uint) eId;
    }

    S s;

    function f8(uint n) internal returns (uint8[] memory) {
        uint8[] memory res = new uint8[](n);
        for (uint8 i = 0; i < n; i++) {
            res[i] = i;
        }

        return res;
    }

    function f32(uint n) internal returns (uint32[] memory) {
        uint32[] memory res = new uint32[](n);
        for (uint32 i = 0; i < n; i++) {
            res[i] = i;
        }

        return res;
    }

    function f256(uint n) internal returns (uint256[] memory) {
        uint[] memory res = new uint[](n);
        for (uint i = 0; i < n; i++) {
            res[i] = i;
        }

        return res;
    }

    function one() public {
        uint8[][] memory mD = new uint8[][](2);
        mD[0] = f8(3);
        mD[1] = f8(5);

        s = S(
            f256(4),
            hex"000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e",
            hex"000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f",
            mD,
            //id,
            this.eId
        );
    }

    function two() public {
        uint8[][] memory mD = new uint8[][](0);
        
        s = S(
            f256(0),
            hex"",
            hex"",
            mD,
            //id,
            this.eId
        );
    }

    function three() public {
        uint8[][] memory mD = new uint8[][](1);
        mD[0] = f8(1);

        s = S(
            f256(1),
            hex"01",
            hex"01",
            mD,
            //id,
            this.eId
        );
    }

    function four() public {
        delete s;
    }
}

contract __IRTest__ {
    function main() public payable {
        Foo __this__ = new Foo();
        __this__.one();
        __this__.two();
        __this__.three();
        __this__.four();

    }
}
