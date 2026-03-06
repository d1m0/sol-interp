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

    function multiple_events() public {
        emit E();
        emit E2(1);
        emit E3(2);
        emit E4("abc");
        emit E5("def");        
        emit E6(3, "hij");
        emit E7(4, "klm");
        emit E8(6, "nop");
        emit E5("qrs");
        emit E1();
        emit E9(7, "qrs");
    }

    function multiple_events_with_revert() public {
        emit E();
        emit E2(1);
        emit E3(2);
        uint a = 0;
        uint b = 1;
        emit E2(b/a);
        emit E4("abc");
    }

    bytes32[] t;

    function multiple_events_with_misalignment() public {
        emit E();
        emit E2(1);
        emit E3(2);

        uint i = 0;
        while (true) {
            t.push(keccak256(abi.encode(i++)));
        }
        emit E4("abc");
    }
} 

contract __IRTest__ {
    function main() public payable {
        Events __this__ = new Events();
        __this__.multiple_events();

        try __this__.multiple_events_with_revert() {
            assert(false);
        } catch {

        }
        
        try __this__.multiple_events_with_misalignment{gas: 4000 }() {
            assert(false);
        } catch  {
            
        }
    }
}
