pragma solidity 0.8.29;

type Myint is int256;

function add(Myint a, Myint b) pure returns (Myint) {
    return Myint.wrap(Myint.unwrap(a) + Myint.unwrap(b));
}
function mul(Myint a, int256 b) pure returns (Myint) {
    return Myint.wrap(Myint.unwrap(a) * b);
}
function neg(Myint a) pure returns (Myint) {
    return Myint.wrap(-Myint.unwrap(a));
}

using { add as +, neg as - } for Myint global;

contract __IRTest__ {

    function main() public payable {
        Myint a = Myint.wrap(1);
        Myint b = Myint.wrap(2);

        assert(Myint.unwrap(add(a, b)) == 3);
        assert(Myint.unwrap(a + b) == 3);
        assert(Myint.unwrap(-a) == -1);
    }
}