[![Documentation](https://github.com/d1m0/sol-interp/workflows/Deploy%20docs/badge.svg)](https://consensys.github.io/sol-interp/)
[![npm](https://img.shields.io/npm/v/sol-interp)](https://www.npmjs.com/package/sol-interp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NodeJS CI](https://github.com/d1m0/sol-interp/actions/workflows/test.yml/badge.svg)](https://github.com/d1m0/sol-interp/actions/workflows/test.yml)

# Intro

`sol-interp` is a full interpreter for the Solidity language. The interpreter can either be used programmatically, or you can play with it from the CLI.
This repo includes 2 CLI tools:

- `sol-interp` allows you to interpret any contracts in a mock empty chain, running a sequence of calls and deployments. All contracts are interpreted
- `replay` allows you to take an existing mainnet transaction(TX), and try to replay any segments of the TX for which there is source code using the interpreter. (sources are automatically fetched from Etherscan)

Additionally the `sol-interp` npm package is build and deployed from this repo. This allows the interpreter to be used programmatically.

# Installation

You can install the npm package:

```bash
npm install sol-interp
```

Or build from source:

```bash
git clone git@github.com:d1m0/sol-interp.git
cd sol-interp
npm install
```


# CLI Usage

## Interpreting Contracts

To play around with the interpreter, all you need is an example contract. For example given the following `fib.sol` file:

```solidity
contract Fib {
    function fib(uint x) public returns (uint) {
        if (x == 0) {
            return 0;
        }

        if (x == 1) {
            return 1;
        }

        return fib(x-1) + fib(x-2);
    }
}
```

You can directly interpret the given file. To run it, you need to specify two steps - (1) how to deploy an instance of `Fib` and (2) how to call `Fib.fib()`. E.g.:

```bash
sol-interp fib.sol --steps 'deploy:Fib()@$f' 'call:$f.fib(2)'
```

Or if you are running from inside the repo:

```bash
npm run build
node dist/bin/cli.js fib.sol --steps 'deploy:Fib()@$f' 'call:$f.fib(2)'
```

Under the hood the CLI interface will compile the given source files, and then run the specified steps using the given compiler artifacts.
The first step `deploy:Fib()$f` specifies that we want to deploy an instance of the `Fib` contract, to a local chain. The `Fib` constructor takes no arguments (currently the CLI only supports numeric, string and boolean literals and address variables).
If you wanted for example to pass 42 to the constructor, the invocation would be `deploy:Fib(42)@$f`. The last part - `@$f` specifies that the address of the newly deployed contract should be remembered as `$f` for use in the later steps.

The next step - `call:$f.fib(2)` specifies that we want to invoke the `fib` method on the deployed contract at address `$f`, giving it as input `2`.
Once the above steps are ran, you should see something like:

```bash
succeeded
return [1]
```

This output specifies that the first step (deployment) succeeded, and that the second step (call) returned `1`.
Its more interesting to run the same command with `-v`:

```bash
node dist/bin/cli.js fib.sol --steps 'deploy:Fib()@$f' 'call:$f.fib(2)' -v
```

This will produce a record of each individual step the interpreter takes. E.g.:

```bash
[----:--]call 0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97 -> 0x0000000000000000000000000000000000000000
[----:--]  return 0x608060405234801561000f575f5ffd5b5060043610610029575f3560e01c8063c6c2ea171461002d575b5f5ffd5b610047600480360381019061004291906100f1565b61005d565b604051610054919061012b565b60405180910390f35b5f5f820361006d575f90506100b5565b6001820361007e57600190506100b5565b61009360028361008e9190610171565b61005d565b6100a86001846100a39190610171565b61005d565b6100b291906101a4565b90505b919050565b5f5ffd5b5f819050919050565b6100d0816100be565b81146100da575f5ffd5b50565b5f813590506100eb816100c7565b92915050565b5f60208284031215610106576101056100ba565b5b5f610113848285016100dd565b91505092915050565b610125816100be565b82525050565b5f60208201905061013e5f83018461011c565b92915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f61017b826100be565b9150610186836100be565b925082820390508181111561019e5761019d610144565b5b92915050565b5f6101ae826100be565b91506101b9836100be565b92508282019050808211156101d1576101d0610144565b5b9291505056fea264697066735822122086c162b11f445b775d9e728f56368790d013c54653d80da0d7b53b97c59d014464736f6c634300081d0033
succeeded
[----:--]call 0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97 -> 0x93a5b04040b9d24ea0bb4aaa19967294bcbf44d2
[3:17]    eval 0 -> 0
[3:12]    eval x -> 2
[3:12]    eval x == 0 -> false
[3:8]  exec if (x == 0) {
    return 0;
}
...
[----:--]  return 0x0000000000000000000000000000000000000000000000000000000000000001
```

Each line is one step of execution. The first part of the line - `[3:17]` for example - determines the source location of the expression/statement being evaluated (if any).
Next we have the step type. We currently have 2 step types. An eval step (e.g. `eval x -> 2`) specifies that a given expression evaluated to a value. An exec step (e.g. `exec if (x == 0) {...`) specifies that a statement finished executing.

Its instructive to play around with various solidity samples and the interpreter, to get an understanding of how it evaluates code.

## Replaying Transactions

Another executable - `replay` (`dist/bin/replay.ts`) provides infrastructure for replaying mainnet TXs (or parts thereof) using the interpreter. Running it requires an Etherscan API key and a Quicknode endpoint. (It might work with other similar endpoints, I haven't tested it though). E.g.:

```
node dist/bin/replay.js -e <ETHERSCAN-API-KEY> -q <QUICKNODE-ENDPOINT> -t 0x9abf371cdbd41c0e2b0dbe9cdf1468785ae87e1fee9e2271f88850fdfb24e2d3
```

Currently this executable is used mostly for large-scale test runs, so it only emits replay statistics in JSON format for analysis. However it can be a useful starting point for building other TX replay infrastructure. Additionally you can replay all TXs in a block by specifying `-b <block-num>` instead of `-t <tx-hash>`.

# Programmatic Usage

You can directly embed the interpreter in your own projects with just a couple of lines. For example, assuming that we have a [Solidity standard JSON artifact](https://docs.soliditylang.org/en/latest/using-the-compiler.html#output-description) in `fib.json`, one can instantiate an interpreter and run TXs against `Fib` as follows:


```typescript
import * as fse from "fs-extra";
import { createBlock } from "@ethereumjs/block";
import { createTx } from "@ethereumjs/tx";
import { Address, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { FixedSetBlockManager, InterpEEI, SolMessage, SolMessageType, ArtifactManager  } from "sol-interp";
import { ImmMap, PartialSolcOutput, ZERO_ADDRESS } from "sol-dbg";

const SENDER = createAddressFromString("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97");
const artifact: PartialSolcOutput = fse.readJSONSync("fib.json");
const artifactManager = new ArtifactManager([artifact]);

// Create an empty local "chain" with a single block
const block = createBlock({});
const chain = new InterpEEI(
    artifactManager,
    ImmMap.fromEntries([]),
    block,
    createTx({}),
    new FixedSetBlockManager([block])
);

// Add sender account
chain.makeEmptyAccount(SENDER, 1000000000000n);

// Deploy Fib
// The msg data is just Fib's creation bytecode
const fibCreationBytecode = hexToBytes(`0x${artifact.contracts["fib.sol"]["Fib"].evm.bytecode.object}`)
const deployMsg = SolMessage.testMessage(
    SolMessageType.CREATE,
    SENDER,
    ZERO_ADDRESS,
    fibCreationBytecode,
    0n,
    1000n,
    0n
)
let res = chain.execMsg(deployMsg);
console.error(`Deploy: Reverted?: ${res.reverted} new contract address: ${res.newContract ? res.newContract.toString() : '<none>'}`)

// Call fib(3)
// Get the address of the newly deployed contract Fib
const fibAddr = (res.newContract as Address);
// Construct msg.data from fib()'s selector (0xc6c2ea17) and the abi-encoded uint 3
const callData = hexToBytes("0xc6c2ea170000000000000000000000000000000000000000000000000000000000000003")
const callMsg = SolMessage.testMessage(
    SolMessageType.CALL,
    SENDER,
    fibAddr,
    callData,
    0n,
    0n,
    1n
)

res = chain.execMsg(callMsg);
console.error(`Call: Reverted?: ${res.reverted} res: ${bytesToHex(res.data)}`)
```

In order to look at the individual steps being executed you can register an `InterpVisitor`. For example the `TraceVisitor` will accumulate all executed steps. E.g.:

```typescript
...
const chain = new InterpEEI(
    artifactManager,
    ImmMap.fromEntries([]),
    block,
    createTx({}),
    new FixedSetBlockManager([block])
);
const visitor = new TraceVisitor();
chain.addVisitor(visitor);
...
// Run all the TXs
...
const trace: Trace = chain.getTrace();
for (const step of trace) {
    ...
}
```

# Documentation

You can find the reference documentation [here](https://d1m0.github.io/sol-interp/). You can find articles describing this work in the [dev blog](https://d1m0.github.io/sol-tooling/).

# On AI

All code in this repo is fully and lovingly **human** made. Fuck AI.
