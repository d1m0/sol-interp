pragma solidity 0.6.5;

contract Recepient {
    function getMoney() public payable {}
    function failToGetMoney() public payable {
        revert();
    }
}

contract ChildSuccess {
    constructor() public payable {
        assert(address(this).balance == 3);
    }
}

contract Foo {
    constructor() public payable {}
	function main() public {
        ChildSuccess c = (new ChildSuccess){value:10}.value(3)();
        Recepient r = new Recepient();

        r.getMoney{gas: 0}{value:0}.value(4)();

        assert(address(r).balance == 4);
	}
}

