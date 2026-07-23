Errors:
- #87 Match weird 0.4.x behavior casting return of exterrnal void function to boolean #87
    0x235199dd599fcdef375b03c8adfb8202c32c20db4eaaad147393610615107eea
    0x6fb18698b93913af37e75e16df589d3bc30cfb72be06acee3da04ebd70893ef0
    0x146915aecb5f5f61ae011f1ead182f97dcacc35f09502ce1fdc3ebee88deb105  
- #119 https://github.com/d1m0/sol-interp/issues/119
    0x722c4f68f4263c81cd70d13f1470c38938f03d16f631be1cdc9aed02ed750af8
- https://github.com/d1m0/sol-interp/issues/120
    0x20e22af82242c730939a2c1683803048f37b1d0ae8f57e76b7559e3dd6db65d1
    0xa78ff9fb68b1bda0fefad7d4dadd095342ec8b4272ff8605e7ea128e3f5ae1a0
    0x5df61ddfe15f503b6caaf0defbdfca0bce7ed58c9ffb960bc961242f58a685db
- https://github.com/d1m0/sol-interp/issues/121
    0xb07cb129d7efd304afed7e8bf6bc37f1e9b5eaafe6369f100aface2f83e9327a
    0x87680938a9d89a22882efc18f9643a06367838cb5690e030106305d98e5a97d9
- https://github.com/d1m0/sol-interp/issues/122
    0xefedab22048b44f5f3dd2e763da1ccc0b5f704893125894316a1657238335711

- Static call order
    0xd0c0adb0f47491dbf73f95a8dfdbf799720f319191276e2c4800a6f36001545d (multiplication order)

- Mising precompile (0x5 - modexp,)
    0x49435000c266ec3088a174849d61cb1a748eab7ad42cb31560753b50a843004e

Writing ideas:
    - care to match low-level behavior: implemeting the differences between IR and old code-gen
    - KhyberPass.doTrade bug in 0x6fb18698b93913af37e75e16df589d3bc30cfb72be06acee3da04ebd70893ef0
    - tx 0xa22a77d8dddeec11f23b713e9aea21c615c9dc2d2e94095735874b3dacdf6e0a and the MEV bot calling UniswapV3Pool with a negative amountSpecified and sqrtPriceLimitX96 not cleanly decoding to uint160.

Leftover
- blobhash
- selfdestruct
- block.blobbasefee
- ripemd160
- refactor this.expect to use template strings like sol.assert as an optimization
- test virtual function resolves to public getter
- is "foo".length byte length or uncode code points?
- add test with order of operations for old and new style gas/value/salt passing

expr.getClosestParentByType(sol.ContractDefinition).name
expr.getClosestParentByType(sol.FunctionDefinition).name
state.account.address.toString()
state.codeAccount.address.toString()