pragma solidity 0.8.28;

library Lib {
    function get(mapping(uint => uint) storage m, uint key) external returns (uint) {
        return m[key];
    }

    function swap(mapping(uint => uint) storage m, mapping(uint => uint) storage n) external returns (mapping(uint => uint) storage, mapping(uint => uint) storage) {
        return (n, m);
    }
}

contract MapPtrs {
    mapping(uint => uint) a;
    mapping(uint => uint) b;

    function main() public {
        a[1] = 1;
        b[1] = 2;

        assert(Lib.get(a, 1) == 1);
        assert(Lib.get(b, 1) == 2);

        (mapping(uint => uint) storage c, mapping(uint => uint) storage d) = Lib.swap(a,b);
        
        assert(Lib.get(c, 1) == 2);
        assert(Lib.get(d, 1) == 1);
    }
}

contract __IRTest__ {
    function main() public payable {
        MapPtrs __this__ = new MapPtrs();
        __this__.main();
    }
}