pragma solidity 0.8.28;

function getABC() returns (string memory) {
    return "abc";
}

contract Base {
    struct S {
        uint a;
        bytes2 b;
    }
    uint x = 1;
    uint y = addX(1);
    bytes z = new bytes(y);
    string t = getABC();
    S s = S(1, 0x0102);
    uint8[] arr = [1,2,3];

    function addX(uint v) internal returns (uint) {
        return x + v;
    }

    constructor() {
        assert(x == 1);
        assert(y == 2);
        assert(z.length == 2);
        assert(bytes(t).length == 3);
        assert(s.a == 1);
        assert(s.b == 0x0102);
        assert(arr.length == 3);
        assert(arr[0] == 1 && arr[1] == 2 && arr[2] == 3);
    }
}

contract Child is Base {
    uint cx = x;
    string st = t;

    constructor() {
        assert(cx == 1);
        assert(bytes(st).length == 3);
    }
}

contract Main {
    function main() public {
        Child c = new Child();
    }
}