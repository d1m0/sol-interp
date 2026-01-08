import {
    ExternalFunRef,
    InternalFunRef,
    Poison,
    ppStorage,
    Slice,
    toHexString,
    View
} from "sol-dbg";
import {
    BuiltinFunction,
    BuiltinStruct,
    BytesStorageLength,
    CurriedVal,
    DefValue,
    ExternalCallDescription,
    LValue,
    NewCall,
    TypeValue,
    Value,
    ValueTypeConstructors
} from "./value";
import { Address, bytesToHex } from "@ethereumjs/util";
import { EvalStep, ExceptionStep, ExecStep, ExtCallStep, ExtReturnStep, Trace } from "./step";
import { printNode } from "./utils";
import { ArtifactManager } from "./artifactManager";
import { AccountInfo } from "./chain";

export function ppLValue(v: LValue): string {
    if (v instanceof View) {
        return v.pp();
    } else if (v === null) {
        return `null`;
    } else if (v instanceof BytesStorageLength) {
        return `${ppValue(v.view)}.length`;
    } else {
        return `[${v.map(ppLValue).join(", ")}]`;
    }
}

export function ppValue(v: Value): string {
    if (v instanceof BuiltinFunction) {
        return `<builtin fun ${v.name}>`;
    } else if (v instanceof BuiltinStruct) {
        return `<builtin struct ${v.name}>`;
    } else if (v instanceof Array) {
        return `[${v.map(ppValue).join(", ")}]`;
    } else if (v instanceof View) {
        return v.pp();
    } else if (v instanceof Uint8Array) {
        return bytesToHex(v);
    } else if (v instanceof Poison) {
        return v.constructor.name;
    } else if (v instanceof Address) {
        return v.toString();
    } else if (v instanceof ExternalFunRef) {
        return `<external fun ref to ${v.selector}@${v.address}>`;
    } else if (v instanceof InternalFunRef) {
        return `<internal fun ref to ${v.fun.name}>`;
    } else if (v instanceof Slice) {
        return `<slice [${v.start}:${v.end}]>`;
    } else if (v instanceof DefValue || v instanceof TypeValue) {
        return v.pp();
    } else if (v instanceof ExternalCallDescription) {
        return `<external call to ${ppValue(v.target)} with gas ${v.gas} value ${v.value} salt ${v.salt} of kind ${v.callKind}`;
    } else if (v instanceof NewCall) {
        return `<new call to ${v.type.pp()}>`;
    } else if (v instanceof CurriedVal) {
        return `<curried ${ppValue(v.target)} with args [${v.args.map(ppValue).join(",")}] of types [${v.argTs.map(t => t.pp()).join(",")}]>`
    } else {
        return `${v}`;
    }
}

function ppLVorRV(v: LValue | Value): string {
    if (v instanceof View || v === null || v instanceof BytesStorageLength) {
        return ppLValue(v);
    }

    if (v instanceof Array) {
        return `[${v.map(ppLVorRV).join(", ")}]`;
    }

    return ppValue(v);
}

export function ppMem(m: Uint8Array): string {
    const lines: string[] = [];
    for (let i = 0; i < m.length / 32 + (m.length % 32 != 0 ? 1 : 0); i++) {
        lines.push(`${toHexString(i * 32)}: ${bytesToHex(m.slice(i * 32, (i + 1) * 32))}`);
    }
    return lines.join("\n");
}

export function ppTrace(t: Trace, artifactManager: ArtifactManager): string {
    let indent = "";
    const lines = t.map((step) => {
        if (step instanceof ExecStep) {
            const [line, col] = artifactManager.getStartLoc(step.stmt);
            return `[${line}:${col}]${indent}exec ${printNode(step.stmt)}`;
        } else if (step instanceof EvalStep) {
            const [line, col] = artifactManager.getStartLoc(step.expr);
            return `[${line}:${col}]${indent}  eval ${printNode(step.expr)} -> ${ppLVorRV(step.val)}`;
        } else if (step instanceof ExtCallStep) {
            const s = `[----:--]${indent}call ${step.msg.from.toString()} -> ${step.msg.to.toString()}`;
            indent += "  ";
            return s;
        } else if (step instanceof ExtReturnStep) {
            const s = `[----:--]${indent}return ${bytesToHex(step.res.data)}`;
            indent = indent.slice(0, -2);
            return s;
        } else if (step instanceof ExceptionStep) {
            const s = `[----:--]${indent}error ${bytesToHex(step.exception.payload)}`;
            indent = indent.slice(0, -2);
            return s;
        } else {
            return `nyi(${step.constructor.name})`;
        }
    });

    return lines.join(`\n`);
}

export function ppValueTypeConstructor(typeConstructor: ValueTypeConstructors): string {
    if (typeConstructor === BigInt) {
        return "bigint";
    }

    if (typeConstructor === Boolean) {
        return "boolean";
    }

    if (typeConstructor === Array) {
        return "Value[]";
    }

    return typeConstructor.constructor.name;
}

export function ppAccount(a: AccountInfo): string {
    return `{
        balance: ${a.balance},
        nonce: ${a.nonce},
        storage: ${ppStorage(a.storage)}
    }`;
}
