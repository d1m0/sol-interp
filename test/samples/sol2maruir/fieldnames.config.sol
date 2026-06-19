pragma solidity 0.8.28;

contract B {
    
}

contract A is B {
    constructor(uint a, bool b) {}
}

contract __IRTest__ {
    struct S {
        uint x;
        bool y;
    }

    string public log;

    function add(string memory s) public {
        log=string.concat(log, s);
    }

    function internalMark(address a, string memory tag) internal returns (address) {
        add(tag);
        return a;
    }

    function foo(uint a, bool b) public returns (uint) {
        return b ? a : a + 1;
    }

    function getBool(bool b, string memory tag) external returns (bool) {
        this.add(tag);
        return b;
    }

    function getUint(uint b, string memory tag) external returns (uint) {
        this.add(tag);
        return b;
    }

    function main() public payable {
        add("foo({b: true, a: 1}: ");
        assert(foo({b: this.getBool(true, "b"), a: this.getUint(1, "a")}) == 1);
        add(" foo({a: 1, b: false}: ");
        assert(foo({a: this.getUint(1, "a"), b: this.getBool(false, "b")}) == 2);

        add(" {y: this.getBool(true, \"y\"), x: this.getUint(1, \"x\")}: ");
        S memory s = S({y: this.getBool(true, "y"), x: this.getUint(1, "x")});
        add(" {x: this.getUint(1, \"x\"), y: this.getBool(true, \"y\"), }: ");
        S memory s1 = S({x: this.getUint(1, "x"), y: this.getBool(true, "y")});

        add(" A({b: this.getBool(true, \"b\"), a: this.getUint(1, \"a\")}): ");
        A a = new A({b: this.getBool(true, "b"), a: this.getUint(1, "a")});

        // Error: Not allowed for function references
        //function (uint a, uint b) internal returns (uint) f = boo;
        //f({b: 1, a: 2});

        assert(keccak256(abi.encode(log)) == keccak256(abi.encode("foo({b: true, a: 1}: ab foo({a: 1, b: false}: ab {y: this.getBool(true, \"y\"), x: this.getUint(1, \"x\")}: xy {x: this.getUint(1, \"x\"), y: this.getBool(true, \"y\"), }: xy A({b: this.getBool(true, \"b\"), a: this.getUint(1, \"a\")}): ab")));
    }
}