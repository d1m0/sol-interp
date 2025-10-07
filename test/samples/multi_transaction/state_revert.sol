pragma solidity 0.8.29;

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

contract ChildFail {
    constructor() public payable {
        require(address(this).balance == 2, "msg");
        revert();
    }
}

contract Foo {
    constructor() payable {
        assert(address(this).balance == 11);
    }
    uint x;

    function cmpAndSetX(uint expV, uint newV) external {
        assert(x == expV);
        x = newV;
    }

    function setXAndFail(uint a) external {
        x = a;
        revert();
    }

    function testBalance() public {
        Recepient r = new Recepient();

        assert(address(r).balance == 0);
        r.getMoney{value: 1}();
        assert(address(r).balance == 1);

        try r.failToGetMoney{value: 1}() {
            assert(false);
        } catch {
            assert(address(r).balance == 1);
        }

        try r.getMoney{value: 101}() {
            assert(false);
        } catch (bytes memory data) {
            assert(data.length == 0);
        }
    }

    function testNonce() public returns (address) {
        uint oldBal = address(this).balance;

        try new ChildFail{value: 2}() returns (ChildFail c) {
            //assert(false);
        } catch Error(string memory msg) {
            //assert(false);
        }  catch (bytes memory lowLevelData) {
            assert(lowLevelData.length == 0);
            assert(oldBal == address(this).balance);
        }

        try new ChildSuccess{value:3}() returns (ChildSuccess c) {
            assert(address(this).balance == oldBal - 3);
            assert(address(c) == 0xD5DA07DdbC00bD592642628e1E032af770CcC706);
        } catch {
            assert(false);
        }
    }

    function testStateRevert() public {
        x = 0;

        this.cmpAndSetX(0, 1);

        assert(x == 1);

        try this.setXAndFail(2) {
            assert(false);
        } catch {
        }
        
        assert(x == 1);
    }

    function main() public {
        testStateRevert();
        testBalance();
        testNonce();
    }
}
