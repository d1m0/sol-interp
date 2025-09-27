pragma solidity 0.8.29;

contract Base {
    uint a = 13;
    uint public b;

    constructor(uint x) public {
        b = x;
    }
}

contract Child is Base {
    constructor() Base(a++) public {
        assert(a == 14);
        assert(b == 13);
    }
}

contract Main {
    function main() public {
        Child c = new Child();
    }
}