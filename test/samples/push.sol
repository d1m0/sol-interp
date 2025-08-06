pragma solidity 0.8.28;

contract Foo {
    uint8[] u8Arr;
    bytes[] sArr;
    bytes bts;

    uint[][] u2dArr;

    function main() public {
        assert(u8Arr.length == 0);
        u8Arr.push(1);
        assert(u8Arr.length == 1 && u8Arr[0] == 1);
        u8Arr.push();
        assert(u8Arr.length == 2 && u8Arr[0] == 1 && u8Arr[1] == 0);

        sArr.push(hex"2a2b2c");
        sArr.push();

        assert(sArr.length == 2 && sArr[0].length == 3 && sArr[1].length == 0);

        bts = hex"010203";
        assert(bts.length == 3);
        
        bts.push();
        assert(bts.length == 4 && bts[2] == 0x03 && bts[3] == 0x00);

        // pop
        u8Arr.pop();
        assert(u8Arr.length == 1 && u8Arr[0] == 1);
        u8Arr.push(3);
        assert(u8Arr.length == 2 && u8Arr[0] == 1 && u8Arr[1] == 3);
        u8Arr.pop();
        u8Arr.push();
        assert(u8Arr.length == 2 && u8Arr[0] == 1 && u8Arr[1] == 0);

        sArr.pop();
        assert(sArr.length == 1 && sArr[0].length == 3);
        sArr.push(hex"0a");
        assert(sArr.length == 2 && sArr[0].length == 3 && sArr[1].length == 1);

        bts.pop();
        assert(bts.length == 3 && bts[2] == 0x03);
        bts.push(0x1f);
        assert(bts.length == 4 && bts[2] == 0x03 && bts[3] == 0x1f);
    }
}