contract Foo {
    function slice(bytes calldata b, uint start, uint end) external returns (bytes memory) {
        return b[start:end];
    }

    function strSlice(string calldata b, uint start, uint end) external returns (string memory) {
        return b[start:end];
    }

    function arrSlice(bool[] calldata a, uint start, uint end) external returns (bool[] memory) {
        return a[start:end];
    }
    

    function main() public returns (bytes memory) {
        this.slice(hex"010203", 0, 2);
        try this.slice(hex"010203", 2, 0) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        try this.slice(hex"010203", 0, 4) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        bool[] memory x = new bool[](5);
        x[1] = true;
        x[3] = true;

        try this.arrSlice(x, 1, 3) returns (bool[] memory t) {
            assert(t.length == 2);
        } catch {
            assert(false);
        }

        try this.arrSlice(x, 1, 0) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        try this.arrSlice(x, 10, 12) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        string memory s = "hello world";

        try this.strSlice(s, 1, 3) returns (string memory t) {
            assert(bytes(t).length == 2 && bytes(t)[0] == "e");
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        try this.strSlice(s, 1, 0) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }

        try this.strSlice(s, 10, 12) {
            assert(false);
        } catch (bytes memory b) {
            assert(b.length == 0);
        }
    }
}