pragma solidity 0.8.28;

uint constant c = 4;

function bar(uint x) returns (uint) {
    return x + c; 
}

library Lib {
    uint constant d = 5;

    function boo(uint x) internal returns (uint) {
        return x + c + d;
    }
}
