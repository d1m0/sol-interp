pragma solidity 0.5.0;

contract ArrayPushRv {
    uint[] a;
    string[] b;


    function main() public {
        a.push(1);
        assert(a.length == 1 && a[0] == 1);
        assert(a.push(2) + a[0] == 3);
    }
}
