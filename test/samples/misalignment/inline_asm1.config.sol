pragma solidity 0.8.29;

contract B {
    constructor() {
    }

    function main() public {
        1+1;
    }
}

contract A {
    B b;
    
    constructor() {
        b = new B();
    }

    function main() public {
        2+2;
        assembly {}
        b.main();
        3+3;
    }
}

contract __IRTest__ {
    constructor() {
    }
    
    function main() public payable {
        A a = new A();
        a.main();
    }
}
