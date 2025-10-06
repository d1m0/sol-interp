bytes constant brokenErrorPayload = hex"08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000033336162630000000000000000000000000000000000000000000000000000000000";

function bytesEq(bytes memory b1, bytes memory b2) returns (bool) {
    if (b1.length != b2.length) {
        return false;
    }

    for (uint256 i = 0; i < b1.length; i++) {
        if (b1[i] != b2[i]) {
            return false;
        }
    }

    return true;
}

contract Foo {
    function brokenError() public {
        // correct payload
        //bytes memory payload = hex"08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000036162630000000000000000000000000000000000000000000000000000000000";
        bytes memory payload = brokenErrorPayload;
        assembly {
            let len := mload(payload)
            let off := add(payload, 0x20)
            revert(off, len)
        }
    }

    function callBrokenError() public returns (string memory) {
        try this.brokenError() {

        } catch Error(string memory s) {
            return s;
        } catch (bytes memory d) {
            return "itsok";
        }
    }

    function main() public returns (string memory) {
        try this.callBrokenError() returns (string memory s) {
            return s;
        } catch (bytes memory data) {
            assert(false);
        }
    }
}
