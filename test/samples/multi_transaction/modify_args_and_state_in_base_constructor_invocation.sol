pragma solidity 0.8.29;

contract Base {
    uint public baseY;

    constructor(uint x) public {
        baseY = x;
    }
}

contract Child is Base {
    uint public childY;

    constructor(uint t) Base(childY = t = t + 1) public {
        childY += t + baseY;
    }
}

contract Foo {
    function main() public {
        Child c = new Child(1);
        assert(c.baseY() == 2);
        assert(c.childY() == 6);
    }
}
