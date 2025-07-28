pragma solidity 0.8.28;
error Err();
event E();

contract Foo {
    event E1();

    function main() public  {
        assert(Err.selector == 0xc64fc372);
        assert(E.selector == 0x92bbf6e823a631f3c8e09b1c8df90f378fb56f7fbc9701827e1ff8aad7f6a028);
        assert(Foo.E1.selector == 0x440a57bf0cad4531f0d64cfe9a30829810bbcd2b992d0ef6c9a6bd73bb65c5e5);
    }
}
