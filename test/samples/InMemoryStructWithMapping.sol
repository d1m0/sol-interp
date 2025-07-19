pragma solidity 0.6.0;

library UseStructs {
    struct Some {
        mapping(uint8 => bool) field;
        uint256 other;
    }
}

contract Test {
    UseStructs.Some s;
    UseStructs.Some r;

    struct MapArr {
        mapping(uint=>uint)[2] ms;
        uint256 other;
    }

    MapArr arr;

    function verifyMapArr() public {
        MapArr memory x;
        x.other = 1;
        arr.other = 2;
        arr.ms[0][1] = 42;
        arr.ms[0][2] = 43;

        arr = x;
        assert(arr.other == 1);
        assert(arr.ms[0][1] == 42);
        assert(arr.ms[0][2] == 43);
    }

    function verify() public {
        UseStructs.Some memory x = UseStructs.Some(10);
        UseStructs.Some memory t = UseStructs.Some({other: 11});

        assert(x.other == 10);

        s.other = 20;

        x = s;

        assert(x.other == 20);

        s.other = 30;

        assert(x.other == 20);
        assert(s.other == 30);

        s = x;

        s.field[10] = true;
        s.other = 100;

        assert(s.other == 100);
        assert(s.field[10] == true);

        r = s;

        assert(r.other == 100);
        assert(r.field[10] == false);

        s.other = 200;
        s.field[15] = true;

        r.field[20] = true;

        assert(r.other == 100);
        assert(s.other == 200);

        assert(r.field[10] == false);
        assert(s.field[10] == true);

        assert(r.field[15] == false);
        assert(s.field[15] == true);

        assert(r.field[20] == true);
        assert(s.field[20] == false);

        s = x;
        assert(s.other == 20);
        assert(s.field[10] == true);
    }
}
