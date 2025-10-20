pragma solidity 0.8.29;

contract Foo {
    error E1();
    error E2(uint a, bytes2 b);
    error E3(uint a, string b);

    function bytesEq(bytes memory b1, bytes memory b2) internal returns (bool) {
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

    function throwE1() external {
        revert E1();
    }

    function throwE2() external {
        revert E2(2, 0xffff);
    }

    function throwE3() external {
        revert E3(3, "abcd");
    }

    function revertNoData() external {
        revert();
    }

    function revertMsg() external returns (uint) {
        revert("hi");
    }

    function success() external returns (uint, string memory) {
        return (2, "abc");
    }

    function panicDiv() external {
        uint a = 0;
        1/a;
    }

    function requireNoMsg() external {
        require(false);
    }

    function requireMsg() external {
        require(false, "bye");
    }

    function main() public {
        try this.revertNoData() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(data.length == 0);
        }

        try this.success() returns (uint a, string memory b) {
            assert(a == 2);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(false);
        }

        try this.revertMsg() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(bytes(msg).length == 2);
        } catch (bytes memory data) {
            assert(false);
        }

        try this.panicDiv() {
            assert(false);
        } catch Panic(uint code) {
            assert(code == 0x12);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(false);
        }

        try this.panicDiv() {
            assert(false);
        } catch (bytes memory data) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch Panic(uint code) {
            assert(code == 0x12);
        }
        
        try this.requireNoMsg() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(data.length == 0);
        }

        try this.requireMsg() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(bytes(msg).length == 3);
        } catch (bytes memory data) {
            assert(false);
        }

        try this.requireMsg() {
            assert(false);
        } catch (bytes memory data) {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(bytes(msg).length == 3);
        }

        try this.throwE1() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(bytesEq(data, hex"440a57bf"));
        }

        try this.throwE2() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(bytesEq(data, hex"eda30a960000000000000000000000000000000000000000000000000000000000000002ffff000000000000000000000000000000000000000000000000000000000000"));
        }

        try this.throwE3() {
            assert(false);
        } catch Panic(uint code) {
            assert(false);
        } catch Error(string memory msg) {
            assert(false);
        } catch (bytes memory data) {
            assert(bytesEq(data, hex"f02cd4490000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000046162636400000000000000000000000000000000000000000000000000000000"));
        }

        uint t = 1;
        while(true) {
            try this.throwE1() {
                assert(false);
            } catch {
                break;
            }
            t = 2;
        }

        assert(t == 1);
    }
}
