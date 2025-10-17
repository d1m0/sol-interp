contract ConstructorCode {
    address public thisInConstructor;
    bytes public codeInConstructor;

    constructor() {
        thisInConstructor = address(this);
        codeInConstructor = address(this).code;
    }

    function main() public {
        assert(codeInConstructor.length == 0);
        assert(thisInConstructor == address(this));
    }
}
