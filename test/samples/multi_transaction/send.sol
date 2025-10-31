pragma solidity 0.8.29;

contract ReceiveFallback {
    fallback() external payable { }
}

contract ReceiveReceive {
    receive() external payable { }
}

contract DoesntReceive {
}

contract Foo {
    function main() public payable {
        ReceiveFallback a = new ReceiveFallback();
        ReceiveReceive b = new ReceiveReceive();
        DoesntReceive c = new DoesntReceive();

        assert(payable(a).send(1));
        assert(address(a).balance == 1);

        assert(payable(b).send(2));
        assert(address(b).balance == 2);

        assert(!payable(address(c)).send(1));
        assert(address(c).balance == 0);
    }
}
