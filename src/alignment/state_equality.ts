import { decodeCall, OPCODES, StepState } from "sol-dbg";
import { Interpreter, SolMessage } from "../interp";
import { State } from "../interp/state";
import { InterpVisitorEvent } from "./trace_builder";
import * as sol from "solc-typed-ast"
import { bytesToHex, equalsBytes } from "@ethereumjs/util";

export function statesMatch(interpEvent: InterpVisitorEvent, intepr: Interpreter, state: State, llTrace: StepState[], llIdx: number): boolean {
    sol.assert(llIdx > 1, ``);
    const [hlType, ...hlArgs] = interpEvent;
    const lastLLStep = llTrace[llIdx - 1]

    console.error(`statesMatch(${hlType}, )`)

    if (hlType === "call") {
        if (lastLLStep.op.opcode === OPCODES.CREATE) {
            return true;
        }

        const hlMsg = hlArgs[0] as SolMessage
        const [receiver, codeAddr, msgData,] = decodeCall(lastLLStep);

        const hlReceiver = hlMsg.delegatingContract !== undefined ? hlMsg.delegatingContract : hlMsg.to;
        const hlCodeAddr = hlMsg.to;
        if (!hlReceiver.equals(receiver)) {
            console.error(`Receivers mismatch(${hlMsg.delegatingContract !== undefined}): ${hlReceiver.toString()} llReceiver: ${receiver.toString()}`)
        }

        if (!hlCodeAddr.equals(codeAddr)) {
            console.error(`code adddr mismatch(${hlMsg.delegatingContract !== undefined}): ${hlCodeAddr.toString()} llReceiver: ${codeAddr.toString()}`)
        }

        if (!equalsBytes(msgData, hlMsg.data)) {
            console.error(`msg data mismatch: ${bytesToHex(hlMsg.data)} llReceiver: ${bytesToHex(msgData)}`)
        }

        return hlReceiver.equals(receiver) && hlCodeAddr.equals(codeAddr) && equalsBytes(msgData, hlMsg.data);
    } else {
        return true;
    }
}