import {
    Address,
    bytesToHex,
    concatBytes,
    createAddressFromBigInt,
    createAddressFromString,
    hexToBytes
} from "@ethereumjs/util";
import { Chain } from "../interp";
import { ArtifactManager } from "../interp/artifactManager";
import { TraceVisitor } from "../interp/visitors";
import { ParsedStep } from "./ast/parser";
import {
    address,
    AddressType,
    astToRuntimeType,
    ContractInfo,
    IntType,
    nyi,
    Value,
    ZERO_ADDRESS,
    Value as BaseValue,
    BaseRuntimeType
} from "sol-dbg";
import { BaseInterpType } from "../interp/types";
import { ExpressionNode } from "./ast";
import * as sol from "solc-typed-ast";
import { CallResult, SolMessage } from "../interp/state";
import * as ethABI from "web3-eth-abi";
import { abiTypeToCanonicalName, abiValueToBaseValue, toABIEncodedType } from "../interp/abi";
import { getGetterArgAndReturnTs } from "../interp/utils";

/**
 * Helper class to run a set of steps
 */
export class Runner {
    chain: Chain;
    visitor: TraceVisitor;
    varToAddr = new Map<string, Address>();
    libMap = new Map<string, Address>();
    addrToInfo = new Map<string, ContractInfo>();
    SENDER = createAddressFromString("0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97");

    constructor(private readonly artifactManager: ArtifactManager) {
        this.chain = new Chain(this.artifactManager);
        this.visitor = new TraceVisitor();
        this.chain.addVisitor(this.visitor);

        this.chain.makeEmptyAccount(this.SENDER, 1000000000000n);
    }

    private error(msg: string): never {
        sol.assert(false, msg);
    }

    private expect(cond: boolean, msg?: string): asserts cond {
        sol.assert(cond, msg ? msg : "");
    }

    evalExpr(expr: ExpressionNode, type: BaseInterpType): Value {
        if (type instanceof IntType) {
            this.expect(
                expr.kind === "HexNumber" || expr.kind === "DecNumber",
                `Expected a number for ${type.pp()} not ${expr.kind}`
            );
            return expr.value;
        }

        if (type instanceof AddressType) {
            this.expect(
                expr.kind === "Var" || expr.kind === "HexNumber",
                `Expected a number for ${type.pp()} not ${expr.kind}`
            );

            if (expr.kind === "Var") {
                this.expect(this.varToAddr.has(expr.name), `No contract for var ${expr.name}`);
                return this.varToAddr.get(expr.name) as Address;
            } else {
                return createAddressFromBigInt(expr.value);
            }
        }

        nyi(`Compiling step expression of type ${type.pp()}`);
    }

    lookupContract(name: string): ContractInfo {
        for (const contract of this.artifactManager.contracts()) {
            if (contract.contractName === name) {
                return contract;
            }
        }

        this.error(`Unknown contract ${name}`);
    }

    findMethod(
        contract: sol.ContractDefinition,
        name: string
    ): sol.FunctionDefinition | sol.VariableDeclaration {
        for (const base of contract.vLinearizedBaseContracts) {
            for (const method of base.vFunctions) {
                if (
                    ![sol.FunctionVisibility.External, sol.FunctionVisibility.Public].includes(
                        method.visibility
                    )
                ) {
                    continue;
                }

                if (method.name === name) {
                    return method;
                }
            }

            for (const sVar of base.vStateVariables) {
                if (![sol.StateVariableVisibility.Public].includes(sVar.visibility)) {
                    continue;
                }

                if (sVar.name === name) {
                    return sVar;
                }
            }
        }

        this.error(`No method/getter ${name} in contract ${contract.name}`);
    }

    getMsgFromStep(step: ParsedStep): [SolMessage, ContractInfo] {
        let to: Address;
        let targetContract: ContractInfo;
        let target: sol.FunctionDefinition | sol.VariableDeclaration | undefined;

        if (step.kind === "Deploy") {
            to = ZERO_ADDRESS;
            targetContract = this.lookupContract(step.contract);
            this.expect(targetContract.ast !== undefined);
            target = targetContract.ast.vConstructor;
        } else {
            to = this.evalExpr(step.contract, address) as Address;
            const info = this.addrToInfo.get(to.toString());
            this.expect(info !== undefined, `Missing contract info for ${to.toString()}`);
            targetContract = info;
            this.expect(targetContract.ast !== undefined);
            target = this.findMethod(targetContract.ast, step.method);
        }

        let argSolTs: sol.TypeNode[] = [];
        const infer = this.artifactManager.infer(targetContract.artifact.compilerVersion);

        if (target instanceof sol.FunctionDefinition) {
            argSolTs = target.vParameters.vParameters.map((decl) =>
                infer.toABIEncodedType(
                    infer.variableDeclarationToTypeNode(decl),
                    sol.ABIEncoderVersion.V2
                )
            );
        } else if (target instanceof sol.VariableDeclaration) {
            argSolTs = infer
                .getterArgsAndReturn(target)[0]
                .map((argT) => infer.toABIEncodedType(argT, sol.ABIEncoderVersion.V2));
        } else {
            argSolTs = [];
        }

        const argRTTs = argSolTs.map((solT) =>
            astToRuntimeType(solT, infer, sol.DataLocation.Memory)
        );
        this.expect(
            argRTTs.length === step.args.length,
            `Mismatch in given arg length (${step.args.length} and number of args (${argRTTs.length} for method ${target ? target.name : "<unknown>"} in ${targetContract.contractName}))`
        );

        const args = step.args.map((exprNode, i) => this.evalExpr(exprNode, argRTTs[i]));
        const abiTypeNames = argSolTs.map(sol.abiTypeToCanonicalName);

        const argData =
            args.length > 0
                ? hexToBytes(ethABI.encodeParameters(abiTypeNames, args) as `0x${string}`)
                : new Uint8Array();
        let data: Uint8Array;

        if (step.kind === "Deploy") {
            const bytecode = this.artifactManager.link(targetContract.bytecode, this.libMap);
            data = concatBytes(bytecode, argData);
        } else {
            this.expect(target !== undefined);
            const selector = hexToBytes(`0x${infer.signatureHash(target)}`);
            data = concatBytes(selector, argData);
        }

        return [
            {
                from: this.SENDER,
                delegatingContract: undefined,
                to,
                data,
                gas: 0n,
                value: 0n,
                salt: undefined,
                isStaticCall: false
            },
            targetContract
        ];
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

    run(step: ParsedStep): [CallResult, BaseValue[] | undefined] {
        const [msg, info] = this.getMsgFromStep(step);

        const res = step.kind === "Deploy" ? this.chain.create(msg) : this.chain.call(msg);

        let decodedReturns: BaseValue[] | undefined;

        if (step.kind === "Deploy" && !res.reverted) {
            const newAddr = res.newContract;
            this.expect(newAddr !== undefined);

            this.addrToInfo.set(newAddr.toString(), info);
            if (step.name) {
                this.varToAddr.set(step.name.name, newAddr);
            }

            if (info.ast && info.ast.kind === sol.ContractKind.Library) {
                this.libMap.set(`${info.fileName}:${info.contractName}`, newAddr);
            }
        }

        if (step.kind === "Call" && !res.reverted) {
            const fun = this.artifactManager.findEntryPoint(msg.data, info);

            if (fun) {
                const infer = this.artifactManager.infer(info.artifact.compilerVersion);
                decodedReturns = this.decodeReturns(res.data, fun, infer);
            }
        }

        return [res, decodedReturns];
    }
}
