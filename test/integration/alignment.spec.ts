import { loadSamples, txDescToBlockData, txDescToTxData } from "../unit/utils";
import * as fse from "fs-extra";
import { ContractInfo, ImmMap, PartialSolcOutput, Scenario } from "sol-dbg";
import { AccountInfo, AccountMap, buildAlignedTraces } from "../../src";
import { createAddressFromString, equalsBytes } from "@ethereumjs/util";
import { scenarioInitialStateToAccountMap } from "../unit/utils";
import {
    AlignedTraceBuilder,
    AlignedTraces,
    alignedTraceWellFormed,
    hasMisaligned,
    hasNoSource,
    isNoSource,
    makeSolMessage
} from "../../src/alignment";
import { ArtifactManager } from "../../src/interp/artifactManager";
import {
    BlockReplayInfo,
    EVMReplay,
    EVMReplayDesc,
    makeEVMReplayDesc,
    StateDesc
} from "../../src/alignment/evm_trace";
import { assert } from "../../src";
import { stateManagerToAccountMap } from "../../src/alignment/evm_trace/transformers";

const misalignmentSamples: Array<[string, any]> = [
    [
        "out_of_gas.config.json",
        [
            [1, 1, false, ["EVMCreateEvent", "SolCreateEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMCallEvent", "SolCallEvent"]],
            [2, 2, false, ["EVMCreateEvent", "SolCreateEvent"]],
            [3, 3, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [2, 2, false, ["EVMCallEvent", "SolCallEvent"]],
            [3, 3, true, ["EVMExceptionEvent", "SolExceptionEvent"]],
            [2, 2, false, ["EVMReturnEvent", "SolReturnEvent"]],
            [1, 1, false, ["EVMReturnEvent", "SolReturnEvent"]]
        ]
    ]
];

export async function scenarioToReplayDesc(scenario: Scenario): Promise<EVMReplayDesc> {
    assert(scenario.steps.length > 0, ``);
    const block = txDescToBlockData(scenario.steps[0]);
    return makeEVMReplayDesc(
        block,
        scenario.steps.map((step) => [createAddressFromString(step.origin), txDescToTxData(step)]),
        scenarioInitialStateToAccountMap(scenario.initialState)
    );
}

const hasMisalignment: Set<string> = new Set(misalignmentSamples.map((t) => t[0]));

const sol2maruirScenarios: string[] = fse
    .readdirSync("test/samples/sol2maruir")
    .filter((name) => name.endsWith("config.json"));

/**
 * Given a map from addresses to contract identifiers of the form `fileName:contractName` and an AccountMap `state`
 * for each address, lookup its contract in the given `ArtifactManager`, and if a contract is found, add its info to the relevant
 * `AccountInfo` in `state`.
 */
function addArtifactsToAccountMap(state: AccountMap, artifactManager: ArtifactManager): void {
    // Add contract info to initial state
    for (const [, accountInfo] of state.entries()) {
        const info = artifactManager.getContractFromDeployedBytecode(accountInfo.deployedBytecode);

        if (info) {
            accountInfo.contract = info;
        }
    }
}

describe("Trace Alignment Tests", () => {
    for (const sample of sol2maruirScenarios) {
        if (hasMisalignment.has(sample)) {
            continue;
        }

        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, stateAfter, llTrace] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc),
                    artifactManager,
                    10000
                );
                state = stateAfter;
                expect(
                    alignedTraceWellFormed(alignedTraces, llTrace, artifactManager)
                ).toBeTruthy();
                expect(hasMisaligned(alignedTraces)).toEqual(false);
            }
        });
    }
});

function alignedTraceToDesc(t: AlignedTraces): any {
    const res: any[] = [];

    for (const p of t) {
        const hlEvtDesc =
            p.type === "aligned" || p.type === "misaligned"
                ? p.hlEndEvent.constructor.name
                : "<undefined>";
        res.push([
            p.llTrace[0].depth,
            p.llTrace[p.llTrace.length - 1].depth,
            p.type !== "aligned",
            [p.llEndEvent.constructor.name, hlEvtDesc]
        ]);
    }

    return res;
}

describe("Trace Misalignment Tests", () => {
    for (const [sample, desc] of misalignmentSamples) {
        it(`${sample}`, async () => {
            const scenario = fse.readJsonSync(`test/samples/sol2maruir/${sample}`) as Scenario;
            const [artifactManager] = await loadSamples(
                [sample.slice(0, -4) + "sol"],
                "test/samples/sol2maruir"
            );
            let state = scenarioInitialStateToAccountMap(scenario.initialState);

            for (let i = 0; i < scenario.steps.length; i++) {
                const txDesc = scenario.steps[i];
                const sender = createAddressFromString(txDesc.origin);
                const [alignedTraces, stateAfter, llTrace] = await buildAlignedTraces(
                    state,
                    txDescToTxData(txDesc),
                    sender,
                    txDescToBlockData(txDesc),
                    artifactManager,
                    10000
                );
                state = stateAfter;
                expect(
                    alignedTraceWellFormed(alignedTraces, llTrace, artifactManager)
                ).toBeTruthy();
                if (i === 1) {
                    expect(hasMisaligned(alignedTraces)).toEqual(true);
                    expect(alignedTraceToDesc(alignedTraces)).toEqual(desc);
                }
            }
        });
    }
});

async function stateDescToAccountMap(state: StateDesc): Promise<AccountMap> {
    const accounts: AccountInfo[] = [];
    for (const addr of state.liveAccounts) {
        accounts.push(await stateManagerToAccountMap(createAddressFromString(addr), state.state));
    }

    return ImmMap.fromEntries(accounts.map((acc) => [acc.address.toString(), acc]));
}

async function alignNthTx(
    replayInfo: BlockReplayInfo,
    artifactManager: ArtifactManager,
    txIdx: number,
    deleteSource: Set<string>,
    maxNumSteps = 10000
): Promise<[AlignedTraces, AccountMap]> {
    const tx = replayInfo.txs[txIdx];
    const initialState: AccountMap = await stateDescToAccountMap(tx.stateBefore);

    addArtifactsToAccountMap(initialState, artifactManager);

    for (const [addr, acc] of initialState.entries()) {
        if (deleteSource.has(addr)) {
            acc.contract = undefined;
        }
    }

    const builder = new AlignedTraceBuilder(
        artifactManager,
        initialState,
        tx.trace,
        makeSolMessage(tx.tx),
        replayInfo.block,
        maxNumSteps
    );

    return await builder.buildAlignedTraces();
}

export function* powerset<A>(s: Set<A>): Iterable<Set<A>> {
    const elements = [...s];
    for (let i = 0; i < 2 ** elements.length; i++) {
        const s = new Set<A>();

        for (let j = 0; j < elements.length; j++) {
            if ((i & (1 << j)) !== 0) {
                s.add(elements[j]);
            }
        }

        yield s;
    }
}

it("Powerset correct", () => {
    let t = [...powerset(new Set())];
    expect(t.length === 1 && t[0].size == 0).toBeTruthy();

    t = [...powerset(new Set([1]))];
    expect(t.length === 2 && t[0].size == 0 && t[1].size == 1).toBeTruthy();

    t = [...powerset(new Set([1, 2]))];
    expect(
        t.length === 4 && t[0].size == 0 && t[1].size == 1 && t[2].size == 1 && t[3].size == 2
    ).toBeTruthy();
});

class PrunedArtifactManager extends ArtifactManager {
    constructor(
        artifacts: PartialSolcOutput[],
        private readonly ignoreCodes: Iterable<Uint8Array>
    ) {
        super(artifacts);
    }

    getContractFromDeployedBytecode(bytecode: Uint8Array): ContractInfo | undefined {
        for (const ignore of this.ignoreCodes) {
            if (equalsBytes(ignore, bytecode)) {
                return undefined;
            }
        }

        return super.getContractFromDeployedBytecode(bytecode);
    }
}

it("Alignment with missing info", async () => {
    const scenario = fse.readJsonSync(
        `test/samples/misalignment/missing_info.config.json`
    ) as Scenario;

    const [artifactManager] = await loadSamples(
        ["missing_info.config.sol"],
        "test/samples/misalignment"
    );

    const replayDesc = await scenarioToReplayDesc(scenario);
    const evmR = await EVMReplay.replay([replayDesc]);

    const hist = evmR.history;
    expect(hist.length).toEqual(1);
    expect(hist[0].txs.length).toEqual(2);

    const [traceDepl, accMap] = await alignNthTx(hist[0], artifactManager, 0, new Set());
    const [traceMain] = await alignNthTx(hist[0], artifactManager, 1, new Set());

    expect(hasMisaligned(traceDepl)).toBeFalsy();
    expect(hasMisaligned(traceMain)).toBeFalsy();

    const stateManager = hist[0].txs[1].stateBefore;

    const allAccountsWithCode = new Set(stateManager.liveAccounts);
    allAccountsWithCode.delete("0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97");

    for (const killSet of powerset(allAccountsWithCode)) {
        const [traceMainWithDel] = await alignNthTx(hist[0], artifactManager, 1, killSet);

        const prunedManager = new PrunedArtifactManager(
            artifactManager.artifacts().map((a) => a.artifact),
            [...killSet].map((addr) => (accMap.get(addr) as AccountInfo).deployedBytecode)
        );

        expect(
            alignedTraceWellFormed(traceMainWithDel, hist[0].txs[1].trace, prunedManager)
        ).toBeTruthy();

        expect(hasNoSource(traceMainWithDel)).toEqual(killSet.size > 0);
        for (const segment of traceMainWithDel) {
            if (isNoSource(segment)) {
                for (const llStep of segment.llTrace) {
                    expect(killSet.has(llStep.address.toString())).toBeTruthy();
                }
            }
        }
    }
});
