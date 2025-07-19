pragma solidity 0.8.29;

contract MapWithStringKeys {
    mapping (string => int) x;
    mapping (bytes => uint) z;
    string y;
    bytes b;
    string scratch;

    function main() public {
        y = 'test';
        b = bytes(y);

        x['test'] = 1;
        string memory foo = 'foo';
        scratch = foo;
        // Get another copy of foo in memory
        string memory foo1 = scratch;
        x[foo] = 2;
        x['boo'] = 3;
        
        assert(x[y] == 1);
        assert(x[foo1] == 2);
        assert(x['boo'] == 3);
        
        z[b] = 4;
        bytes memory bar = b;
        assert(z[bar] == 4);
    }
}
