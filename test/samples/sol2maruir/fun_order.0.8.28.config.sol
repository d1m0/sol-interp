// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

function addAddrs(address a, address b) pure returns (address) {
    unchecked {
        return address(uint160(a) + uint160(b));
    }
    
}

function bytesEq(bytes memory b1, bytes memory b2) returns (bool) {
    if (b1.length != b2.length) {
        return false;
    }

    for (uint i = 0; i < b1.length; i++) {
        if (b1[i] != b2[i]) {
            return false;
        }
    }

    return true;
}

function stringEq(string memory s1, string memory s2) returns (bool) {
    return bytesEq(bytes(s1), bytes(s2));
}

contract Child {
    Main m;
    string tag;

    constructor(Main _m, string memory _tag) {
        m = _m;
        tag = _tag;
    }

    function foo() external returns (address) {
        m.add(tag);
        return address(m);
    }

    function getZero() external returns (uint) {
        m.add(tag);
        return 0;
    }
}

contract Main {
    using {addAddrs} for address;

    string public log;

    function add(string memory s) public {
        log=string.concat(log, s);
    }

    function internalMark(address a, string memory tag) internal returns (address) {
        add(tag);
        return a;
    }

    function main() public returns (string memory) {
        Child a = new Child(this, "receiver,");
        Child b = new Child(this, "argument,");

        add("Internal call with no other calls:");
        internalMark(address(this), "receiver,").addAddrs(internalMark(address(this), "argument,"));

        add("Internal call: ");
        // Receiver and arguments are separated by an internal call - order is "argument,receiver"
        a.foo().addAddrs(b.foo());

        add(" External call: ");
        // Receiver and arguments are separated by an external call - order is "receiver,argument"
        a.foo().call(abi.encodeWithSignature("bar(address)", b.foo()));

        add(" Static call: ");
        // Receiver and arguments are separated by an external call - order is "receiver,argument"
        a.foo().staticcall(abi.encodeWithSignature("bar(address)", b.foo()));

        add(" External Solidity Call: ");
        this.bar{value: a.getZero()}(b.foo());
        return log;

    }

    function bar(address a) public payable {}
}

contract __IRTest__ {
    function main() public payable {
        Main __this__ = new Main();

        string memory res = __this__.main();
        assert(stringEq(res, "Internal call with no other calls:argument,receiver,Internal call: argument,receiver, External call: receiver,argument, Static call: receiver,argument, External Solidity Call: receiver,argument,"));
    }
}