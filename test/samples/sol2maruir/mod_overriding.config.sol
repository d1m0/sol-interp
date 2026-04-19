pragma solidity 0.4.24;

contract Base {
    uint[] a;
    modifier M {
        a.push(1);
        _;
    }

    function foo() M {
        a.push(2);
    }

    function main(uint a, uint b, uint c) public returns (uint) {
        return mulmod(a,b,c);
    }
}

contract Child is Base {
    modifier M {
        a.push(3);
        _;
    }

    function foo() M {
        a.push(5);
        super.foo();
        a.push(6);
    }
    
    function main() public returns (uint[] memory) {
        foo();
        return a;
    }
}

contract __IRTest__ {
    function main() public payable {
        Child c = new Child();

        uint[] memory x = c.main();
        assert(x.length == 5);
        assert(x[0] == 3);
        assert(x[1] == 5);
        assert(x[2] == 3);
        assert(x[3] == 2);
        assert(x[4] == 6);
    }
}
