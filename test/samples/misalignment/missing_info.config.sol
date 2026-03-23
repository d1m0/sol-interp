pragma solidity 0.8.29;

contract F {
    function main(A a, bool fail) public {
        a.add(1);
        assert(!fail);
    }
}

contract E {
    function main(A a) public {
        a.add(2);
    }
}


contract D {
    F f;

    constructor() {
        f = new F();
    }

    function main(A a, bool fail) public {
        f.main(a, false);
        a.add(3);
        try f.main(a, true) {
            assert(false);
        } catch {

        }

        a.add(32);

        assert(!fail);
    }
}

contract C {
    function main(A a) public {
        a.add(4);
    }
}

contract B {
    C c;
    D d;
    E e;

    constructor() {
        c = new C();
        d = new D();
        e = new E();
    }

    function main(A a) public {
        a.add(5);
        c.main(a);
        a.add(6);
        d.main(a, false);

        a.add(31);

        try d.main(a, true) {
            assert(false);
        } catch {
        }

        a.add(7);
        e.main(a);       
        a.add(8);
    }
}

contract A {
    B b;
    uint[] arrA;
    
    constructor() {
        b = new B();
    }

    function add(uint x) external {
        arrA.push(x);
    }

    function main() public {
        this.add(9);
        b.main(this);
        this.add(10);
    }
}

contract __IRTest__ {
    A a;

    constructor() {
        a = new A();
    }
    
    function main() public payable {
        a.main();
    }
}
