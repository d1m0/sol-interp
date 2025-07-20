pragma solidity 0.8.29;

contract New {
    struct S {
        int8 n;
        string s;
        int8[] arr;
    }

    function main() public {
        //wont compile - cant create a single new struct
        //S memory s = new S();
        string memory str = new string(10);
        
        bytes memory bts = new bytes(10);
        assert(bts.length == 10);
        uint[] memory uiarr = new uint[](20);
        assert(uiarr.length == 20);
        S[] memory sarr = new S[](2);

        sarr[0].n = 1;
        sarr[1].n = 2;

        assert(sarr.length == 2);
        assert(sarr[0].n == 1);
        assert(sarr[1].n == 2);

        uint[][] memory arr2d = new uint[][](2);

        assert(arr2d[0].length == 0);
        assert(arr2d[1].length == 0);
    }
}
