import {
    Address,
    bytesToHex,
    concatBytes,
    createAddressFromString,
    hexToBytes
} from "@ethereumjs/util";
import {
    BaseRuntimeType,
    Value as BaseValue,
    ContractInfo,
    Struct,
    ZERO_ADDRESS,
    astToRuntimeType
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as ethABI from "web3-eth-abi";
import { CallResult, SolMessage } from "../../src/interp/state";
import { ArtifactManager } from "../../src/interp/artifactManager";
import {
    abiTypeToCanonicalName,
    abiValueToBaseValue,
    toABIEncodedType
} from "../../src/interp/abi";
import { Chain, Trace } from "../../src";
import { getGetterArgAndReturnTs } from "../../src/interp/utils";
import { TraceVisitor } from "../../src/interp/visitors";

const SENDER = createAddressFromString("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97");

interface ResultCallSuccess {
    tag: "call_success";
    returns: BaseValue[];
}

interface ResultCreateSuccess {
    tag: "create_success";
    newAddress?: Address;
}

interface ResultRevert {
    tag: "success";
    data?: Uint8Array;
}

type Results = ResultCallSuccess | ResultRevert | ResultCreateSuccess;

export interface TransactionDesc {
    type: "call" | "deploy";
    contract: string;
    method: string;
    args: BaseValue[];
    result: Results;
    value?: bigint;
}

function pp(v: BaseValue): string {
    if (v instanceof Address) {
        return v.toString();
    }

    if (v instanceof Array) {
        return "[" + v.map(pp).join(", ") + "]";
    }

    if (v instanceof Struct) {
        return `{${v.entries.map(([name, val]) => `${name}: ${pp(val)}`)}}`;
    }

    return sol.pp(v as unknown as any);
}

export class TransactionSet {
    contractMap = new Map<string, Address>();
    libMap = new Map<string, Address>();
    traceVisitor: TraceVisitor;
    chain: Chain;

    constructor(
        public readonly _artifactManager: ArtifactManager,
        private readonly steps: TransactionDesc[]
    ) {
        this.traceVisitor = new TraceVisitor();
        this.chain = new Chain(this._artifactManager);
        this.chain.addVisitor(this.traceVisitor);
        this.chain.makeEmptyAccount(SENDER, 1000000n);
    }

    encodeArgs(
        args: BaseValue[],
        target: sol.FunctionDefinition | sol.VariableDeclaration,
        infer: sol.InferType
    ): Uint8Array {
        let argTs: string[];

        if (target instanceof sol.FunctionDefinition) {
            argTs = target.vParameters.vParameters.map((decl) =>
                sol.abiTypeToCanonicalName(
                    infer.toABIEncodedType(
                        infer.variableDeclarationToTypeNode(decl),
                        sol.ABIEncoderVersion.V2
                    )
                )
            );
        } else {
            argTs = infer
                .getterArgsAndReturn(target)[0]
                .map((argT) =>
                    sol.abiTypeToCanonicalName(
                        infer.toABIEncodedType(argT, sol.ABIEncoderVersion.V2)
                    )
                );
        }

        return hexToBytes(ethABI.encodeParameters(argTs, args) as `0x${string}`);
    }

    encodeCallArgs(
        args: BaseValue[],
        fun: sol.FunctionDefinition | sol.VariableDeclaration,
        infer: sol.InferType
    ): Uint8Array {
        const argBytes = this.encodeArgs(args, fun, infer);

        return concatBytes(hexToBytes(`0x${infer.signatureHash(fun)}`), argBytes);
    }

    encodeCreateArgs(args: BaseValue[], contract: ContractInfo, infer: sol.InferType): Uint8Array {
        const constructor = contract.ast?.vConstructor;
        let argBytes: Uint8Array;

        if (args.length !== 0) {
            sol.assert(constructor !== undefined, `No constructor on ${contract.contractName}`);
            argBytes = this.encodeArgs(args, constructor, infer);
        } else {
            argBytes = new Uint8Array(0);
        }

        const bytecode = this._artifactManager.link(contract.bytecode, this.libMap);
        return concatBytes(bytecode, argBytes);
    }

    decodeReturns(
        data: Uint8Array,
        fun: sol.FunctionDefinition | sol.VariableDeclaration,
        infer: sol.InferType
    ): BaseValue[] {
        let abiRetTs: BaseRuntimeType[];
        let retTs: BaseRuntimeType[];

        if (fun instanceof sol.FunctionDefinition) {
            retTs = fun.vReturnParameters.vParameters.map((decl) =>
                astToRuntimeType(infer.variableDeclarationToTypeNode(decl), infer)
            );
            abiRetTs = retTs.map(toABIEncodedType);
        } else {
            retTs = getGetterArgAndReturnTs(fun, infer)[1];
            abiRetTs = retTs.map(toABIEncodedType);
        }

        const canonicalRetTNames = abiRetTs.map((retT) => abiTypeToCanonicalName(retT));
        const abiRes = ethABI.decodeParameters(canonicalRetTNames, bytesToHex(data));

        const decodedReturns: BaseValue[] = [];
        for (let i = 0; i < abiRes.__length__; i++) {
            decodedReturns.push(abiValueToBaseValue(abiRes[i] as any as BaseValue, abiRetTs[i]));
        }

        return decodedReturns;
    }

    /**
     * We assume no name collisions in contract tests
     */
    getContract(name: string): ContractInfo {
        const res = this._artifactManager.contracts().filter((info) => info.contractName === name);
        sol.assert(res.length === 1, `No contract named ${name}`);
        return res[0];
    }

    getEntypoint(
        step: TransactionDesc
    ): [ContractInfo, sol.FunctionDefinition | sol.VariableDeclaration | undefined] {
        const info: ContractInfo = this.getContract(step.contract);
        sol.assert(info.ast !== undefined, ``);

        for (const base of info.ast.vLinearizedBaseContracts) {
            if (step.type === "call") {
                let entrypoints: Array<sol.FunctionDefinition | sol.VariableDeclaration> =
                    base.vFunctions.filter((fun) => fun.name === step.method);
                if (entrypoints.length === 1) {
                    return [info, entrypoints[0]];
                }

                entrypoints = base.vStateVariables.filter(
                    (v) =>
                        v.name === step.method &&
                        v.visibility === sol.StateVariableVisibility.Public
                );

                if (entrypoints.length === 1) {
                    return [info, entrypoints[0]];
                }
            } else {
                if (base.vConstructor) {
                    return [info, base.vConstructor];
                }
            }
        }

        if (step.type === "call") {
            sol.assert(false, `No method ${step.method} found on contract ${step.contract}`);
        } else {
            return [info, undefined];
        }
    }

    messageFromStep(step: TransactionDesc): SolMessage {
        let to: Address | undefined;

        const [info, entrypoint] = this.getEntypoint(step);
        const infer = this._artifactManager.infer(info.artifact.compilerVersion);

        if (step.type === "deploy") {
            to = ZERO_ADDRESS;
        } else {
            to = this.contractMap.get(step.contract);
            sol.assert(to !== undefined, `No deployed contract ${step.contract}`);
        }

        let data: Uint8Array;

        if (step.type === "call") {
            data = this.encodeCallArgs(
                step.args,
                entrypoint as sol.FunctionDefinition | sol.VariableDeclaration,
                infer
            );
        } else {
            data = this.encodeCreateArgs(step.args, info, infer);
        }

        return {
            from: SENDER,
            to,
            delegatingContract: undefined,
            data,
            gas: 0n,
            value: step.value === undefined ? 0n : step.value,
            salt: undefined,
            isStaticCall: false
        };
    }

    ppStep(step: TransactionDesc): string {
        return `${step.type} ${step.contract}.${step.method}(${step.args.map(pp).join(", ")})`;
    }

    trace(): Trace {
        return this.traceVisitor.getTrace();
    }

    run(): boolean {
        for (const step of this.steps) {
            const msg = this.messageFromStep(step);
            const [info, entrypoint] = this.getEntypoint(step);
            const infer = this._artifactManager.infer(info.artifact.compilerVersion);
            let res: CallResult;

            if (step.type === "call") {
                res = this.chain.call(msg);
            } else {
                res = this.chain.create(msg);

                if (!res.reverted) {
                    sol.assert(res.newContract !== undefined, ``);
                    this.contractMap.set(info.contractName, res.newContract);

                    if (info.ast && info.ast.kind === sol.ContractKind.Library) {
                        this.libMap.set(`${info.fileName}:${info.contractName}`, res.newContract);
                    }
                }
            }

            if (step.result.tag === "call_success") {
                if (res.reverted) {
                    console.error(`${this.ppStep(step)}: Unexpected revert`);
                    return false;
                }

                const expectedReturnsStr = pp(step.result.returns);
                const actualReturns = this.decodeReturns(
                    res.data,
                    entrypoint as sol.FunctionDefinition | sol.VariableDeclaration,
                    infer
                );
                const actualReturnsStr = pp(actualReturns);

                if (expectedReturnsStr !== actualReturnsStr) {
                    console.error(
                        `${this.ppStep(step)}: Mismatch in returns - expected \n${expectedReturnsStr}\nReceived:\n${actualReturnsStr}`
                    );
                    return false;
                }
            } else if (step.result.tag === "create_success") {
                if (res.reverted) {
                    console.error(`${this.ppStep(step)}: Unexpected revert`);
                    return false;
                }

                sol.assert(res.newContract !== undefined, ``);
                if (step.result.newAddress && !step.result.newAddress.equals(res.newContract)) {
                    console.error(
                        `${this.ppStep(step)}: Expected new address at ${step.result.newAddress.toString()} instead got it at ${res.newContract.toString()}`
                    );
                    return false;
                }
            } else {
                if (!res.reverted) {
                    console.error(`${this.ppStep(step)}: Unexpected success`);
                    return false;
                }
            }
        }

        return true;
    }

    getTrace(): Trace {
        return this.traceVisitor.getTrace();
    }
}
