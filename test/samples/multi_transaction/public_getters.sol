pragma solidity 0.8.29;

contract ComplexPublicGetter {
    struct SubT {
        uint z;
        uint[] arr;
        uint8 w;
    }

    struct Data {
        uint a;
        bytes3 b;
        mapping(uint => uint) map;
        uint[3] c;
        SubT st;
        uint[] d;
        bytes e;
    }
    mapping(uint => mapping(bool => Data[])) public data;
    
    constructor() {
        data[1][true].push();
        data[1][true][0].a = 1;
        data[1][true][0].b = 0x010203;
        data[1][true][0].c = [1,2,3];
        data[1][true][0].d = [1,2,3];
        data[1][true][0].e = hex"deadbeef";
        data[1][true][0].st.z = 12;
        data[1][true][0].st.arr = [5,6];
        data[1][true][0].st.w = 12;
    }
}
