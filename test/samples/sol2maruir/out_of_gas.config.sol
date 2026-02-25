pragma solidity 0.8.4;

contract A {
    fallback() external {
    }
}

contract Test {
    constructor() {}

    function main() public payable {
	A a = new A();
	address(a).call{gas: 3}("");
    }
}

contract __IRTest__ {
    function main() public payable {
        Test __this__ = new Test();
	__this__.main();
    }
}
