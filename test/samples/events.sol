pragma solidity 0.8.29;

contract Events {
    event E();
    event E1() anonymous;
    event E2(uint a);
    event E3(uint indexed a);
    event E4(string s);
    event E5(string indexed s);
    event E6(uint a, string s);
    event E7(uint indexed a, string s);
    event E8(uint a, string indexed s);
    event E9(uint a, string indexed s) anonymous;

    function main() public {
        emit E();
        emit E1();
        emit E2(1);
        emit E3(2);
        emit E4("abc");
        emit E5("def");        
        emit E6(3, "hij");
        emit E7(4, "klm");
        emit E8(6, "nop");
        emit E9(7, "qrs");
    }
} 

