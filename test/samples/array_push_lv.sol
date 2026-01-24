pragma solidity 0.6.0;

contract ArrayPushLV {
    uint[] a;
    string[] b;


    function main() public {
        a.push() = 1;
        assert(a.length == 1 && a[0] == 1);
        //Compiler error
        //a.push(4) = 2;
        b.push() = "abc";
        assert(b.length == 1 && keccak256(bytes(b[0])) == keccak256("abc"));
    }
}
