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
    function main(A a, bool fail) public {
        F f = new F();
        f.main(a, false);
        a.add(3);
        try f.main(a, true) {
            assert(false);
        } catch {

        }
        assert(!fail);
    }
}

contract C {
    function main(A a) public {
        a.add(4);
    }
}

contract B {
    function main(A a) public {
        C c = new C();
        D d = new D();
        E e = new E();
        a.add(5);
        c.main(a);
        a.add(6);
        d.main(a, false);

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
    uint[] arrA;
    function add(uint x) external {
        arrA.push(x);
    }

    function main() public {
        this.add(9);
        B b = new B();
        b.main(this);
        this.add(10);
    }
}

contract __IRTest__ {
    function main() public payable {
        A a = new A();
        a.main();
    }
}
