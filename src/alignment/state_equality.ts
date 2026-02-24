import { decodeCall, OPCODES, StepState } from "sol-dbg";
import { Interpreter, SolMessage } from "../interp";
import { State } from "../interp/state";
import { InterpVisitorEvent } from "./trace_builder";
import * as sol from "solc-typed-ast"
import { bytesToHex } from "@ethereumjs/util";

/**
 * In some cases the LL-data includes some 0-es at the end.
 * Seems to happen when passing empty bytes arrays. So we do fuzzy matching here
 * @todo Investigate why that difference occur
 */
function msgDataEq(hlData: Uint8Array, llData: Uint8Array): boolean {
    if (hlData.length > llData.length) {
        return false;
    }

    for (let i = 0; i < hlData.length; i++) {
        if (hlData[i] !== llData[i]) {
            return false;
        }
    }

    for (let i = hlData.length; i < llData.length; i++) {
        if (llData[i] !== 0) {
            return false
        }
    }

    return true;
}

export function statesMatch(interpEvent: InterpVisitorEvent, intepr: Interpreter, state: State, llTrace: StepState[], llIdx: number): boolean {
    sol.assert(llIdx > 1, ``);
    const [hlType, ...hlArgs] = interpEvent;
    const lastLLStep = llTrace[llIdx - 1]

    if (hlType === "call") {
        if (lastLLStep.op.opcode === OPCODES.CREATE || lastLLStep.op.opcode === OPCODES.CREATE2) {
            // @todo implement create checking
            return true;
        }

        const hlMsg = hlArgs[0] as SolMessage
        const [receiver, codeAddr, msgData, , llValue] = decodeCall(lastLLStep);

        const hlReceiver = hlMsg.delegatingContract !== undefined ? hlMsg.delegatingContract : hlMsg.to;
        const hlCodeAddr = hlMsg.to;

        if (!hlReceiver.equals(receiver)) {
            console.error(`Receivers mismatch(${hlMsg.delegatingContract !== undefined}): ${hlReceiver.toString()} llReceiver: ${receiver.toString()}`)
        }

        if (!hlCodeAddr.equals(codeAddr)) {
            console.error(`code adddr mismatch(${hlMsg.delegatingContract !== undefined}): ${hlCodeAddr.toString()} llCodeAddr: ${codeAddr.toString()}`)
        }

        if (!msgDataEq(hlMsg.data, msgData, )) {
            console.error(`msg data mismatch - hldata: ${bytesToHex(hlMsg.data)} lldata: ${bytesToHex(msgData)}`)
        }

        // @todo compare gas as well.

        return hlReceiver.equals(receiver) && hlCodeAddr.equals(codeAddr) && msgDataEq(hlMsg.data, msgData) && hlMsg.value === llValue;
    } else {
        return true;
    }
}