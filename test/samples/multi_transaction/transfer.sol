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

        payable(a).transfer(1);
        assert(address(a).balance == 1);

        payable(b).transfer(2);
        assert(address(b).balance == 2);

        try this.tryTransfer(payable(b)) {
            assert(address(b).balance == 3);
        } catch {
            assert(false);
        }

        try this.tryTransfer(payable(address(c))) {
            assert(false);
        } catch {
            assert(address(c).balance == 0);
        }
    }

    function tryTransfer(address payable a) public {
        a.transfer(1);
    }
}
