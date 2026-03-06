import {
    BaseMemoryView,
    BaseStorageView,
    hexStrToBuf32,
    ImmMap,
    InitialState,
    nyi,
    PartialSolcOutput,
    PrimitiveValue,
    TxDesc,
    Value,
    ZERO_ADDRESS_STRING
} from "sol-dbg";
import * as sol from "solc-typed-ast";
import * as fse from "fs-extra";
import { BaseScope, LocalsScope } from "../../src/interp/scope";
import { makeStateWithConstants, State } from "../../src/interp/state";
import { Value as InterpValue } from "../../src/interp/value";
import { getStateStorage, isValueType, setStateStorage } from "../../src/interp/utils";
import { addSources, ArtifactManager } from "../../src/interp/artifactManager";
import { AccountInfo, AccountMap, Interpreter } from "../../src";
import { BlockData } from "@ethereumjs/block";
import { TypedTxData } from "@ethereumjs/tx";
import { hexToBigInt, hexToBytes, createAddressFromString } from "@ethereumjs/util";

export function makeState(
    loc: sol.ASTNode,
    interp: Interpreter,
    ...vals: Array<[string, Value]>
): State {
    let nd: sol.ASTNode | undefined = loc;
    const scopeNodes: Array<sol.FunctionDefinition | sol.Block | sol.UncheckedBlock> = [];

    // Create only the dynamic part of the scope (function and blocks)
    while (nd !== undefined) {
        if (
            nd instanceof sol.FunctionDefinition ||
            nd instanceof sol.Block ||
            nd instanceof sol.UncheckedBlock
        ) {
            scopeNodes.unshift(nd);
        }

        nd = nd.parent;
    }

    const contract = loc.getClosestParentByType(sol.ContractDefinition);
    sol.assert(contract !== undefined, ``);
    const contractInfo = interp.artifactManager.getContractInfo(contract);
    sol.assert(contractInfo !== undefined, ``);
    const res = makeStateWithConstants(interp.artifactManager, contractInfo);

    // Builtins
    let scope: BaseScope = interp.makeStaticScope(loc, res);
    for (const nd of scopeNodes) {
        scope = new LocalsScope(nd, res, interp.compilerVersion, scope);
    }

    res.scope = scope as BaseScope;

    for (const [name, val] of vals) {
        const decl = res.scope.findDecl(name);
        sol.assert(decl !== undefined, `Missing decl for name ${name}`);
        const view = res.scope.lookupLocation(decl);
        if (view instanceof BaseMemoryView) {
            view.encode(val, res.memory, res.memAllocator);
        } else if (view instanceof BaseStorageView) {
            setStateStorage(res, view.encode(val, getStateStorage(res)));
        } else {
            nyi(`Encode ${val} in ${view}`);
        }
    }

    return res;
}

export function encodeMemArgs(
    args: Array<[sol.VariableDeclaration, Value]>,
    state: State
): InterpValue[] {
    const res: InterpValue[] = [];

    for (const [name, val] of args) {
        const view = (state.scope as BaseScope).lookupLocation(name);
        sol.assert(view !== undefined, ``);
        if (isValueType(view.type)) {
            res.push(val as PrimitiveValue);
        } else {
            sol.assert(
                view instanceof BaseMemoryView,
                `Unexpected arg view: ${view.constructor.name}`
            );
            view.encode(val, state.memory, state.memAllocator);
            res.push(view);
        }
    }

    return res;
}

function getVersion(source: string): string {
    const version = source.match(/pragma solidity ([0-9.]*);/);
    sol.assert(version !== null, `No pragma found`);
    return version[1];
}

export interface SampleInfo {
    version: string;
    units: sol.SourceUnit[];
}

export type SampleMap = Map<string, SampleInfo>;

export async function loadSamples(
    samples: Array<string | [string, any]>,
    basePath = `test/samples`
): Promise<[ArtifactManager, SampleMap]> {
    const res: SampleMap = new Map();
    const compileResults: Array<[PartialSolcOutput, string]> = [];
    const names: string[] = [];

    for (const sample of samples) {
        let fileName;
        let settings;

        if (sample instanceof Array) {
            [fileName, settings] = sample;
        } else {
            fileName = sample;
            settings = undefined;
        }

        const file = fse.readFileSync(`${basePath}/${fileName}`, {
            encoding: "utf-8"
        });
        const version = getVersion(file);

        names.push(fileName);

        const compileResult = await sol.compileSol(
            `${basePath}/${fileName}`,
            version,
            undefined,
            [sol.CompilationOutput.ALL],
            settings
        );
        compileResults.push([addSources(compileResult.data, compileResult.files), version]);
    }

    const artifactManager = new ArtifactManager(compileResults);
    const artifacts = artifactManager.artifacts();

    for (let i = 0; i < names.length; i++) {
        const artifact = artifacts[i];
        res.set(names[i], { version: artifact.compilerVersion, units: artifact.units });
    }

    return [artifactManager, res];
}

export function txDescToTxData(step: TxDesc): TypedTxData {
    const txData: TypedTxData = {
        value: hexToBigInt(step.value),
        gasLimit: hexToBigInt(step.gasLimit),
        gasPrice: 8,
        data: hexToBytes(step.input),
        nonce: step.nonce
    };

    if (step.address !== ZERO_ADDRESS_STRING) {
        txData.to = createAddressFromString(step.address);
    }

    return txData;
}

export function txDescToBlockData(step: TxDesc): BlockData {
    return {
        header: {
            coinbase: step.origin,
            difficulty: 0,
            gasLimit: step.blockGasLimit,
            number: step.blockNumber,
            timestamp: step.blockTime
        }
    };
}

export function scenarioInitialStateToAccountMap(initalState: InitialState): AccountMap {
    const accEntries: Array<[string, AccountInfo]> = [];
    for (const addrStr in initalState.accounts) {
        const accountDesc = initalState.accounts[addrStr as `0x{string}`];
        const storageEntries: Array<[bigint, Uint8Array]> = [];
        for (const [key, val] of Object.entries(accountDesc.storage)) {
            storageEntries.push([hexToBigInt(key as `0x{string}`), hexStrToBuf32(val)]);
        }

        accEntries.push([
            addrStr,
            {
                address: createAddressFromString(addrStr),
                contract: undefined,
                deployedBytecode: hexToBytes(accountDesc.code),
                storage: ImmMap.fromEntries(storageEntries),
                balance: hexToBigInt(accountDesc.balance),
                nonce: BigInt(accountDesc.nonce)
            }
        ]);
    }

    return ImmMap.fromEntries(accEntries);
}
