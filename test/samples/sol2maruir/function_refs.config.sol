pragma solidity 0.8.28;

contract Base {
    function foo(uint a) public returns (uint) {
        return a + 1;
    }

    function fooExt(uint a) external returns (uint) {
        return a + 1;
    }
}

contract __IRTest__ is Base {
    function main() public payable {
        function (uint) internal returns (uint) f = super.foo;
        function (uint) internal returns (uint) f1 = Base.foo;
        function (uint) internal returns (uint) f2 = foo;
        assert(f(f1(f2(1))) == 4);


        assert(super.foo.selector == 0x2fbebd38);

        // Error - can't even lookup external functions on super()
        // function (uint) external returns (uint) f3 = super.fooExt;
        
        // error (understandable - no receiver address)
        // function (uint) external returns (uint) f3 = Base.fooExt;
        // Can have a naked Base.fooExt
        assert(Base.fooExt.selector == 0xbea8d6c9);

        // Error - can't cast. `Base.fooExt` is of a different function type than external (since it doesn't have an address I guess)
        // function (uint) external returns (uint) f3 = Base.fooExt;
    }
}
