import { ExternalFunRef, InternalFunRef, Poison, Slice, toHexString, View } from "sol-dbg";
import { BuiltinFunction, BuiltinStruct, DefValue, LValue, Value, ValueTypeConstructors } from "./value";
import { Address, bytesToHex } from "@ethereumjs/util";
import { EvalStep, ExecStep, Trace } from "./step";
import { printNode } from "./utils";

export function ppLValue(v: LValue): string {
    if (v instanceof View) {
        return v.pp();
    } else if (v === null) {
        return `null`;
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
    } else if (v instanceof DefValue) {
        return v.pp();
    } else {
        return `${v}`;
    }
}

function ppLVorRV(v: LValue | Value): string {
    if (v instanceof View || v === null) {
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

export function ppTrace(t: Trace): string {
    const lines = t.map((step) => {
        if (step instanceof ExecStep) {
            return `finished exec ${printNode(step.stmt)}`;
        } else if (step instanceof EvalStep) {
            return `    eval ${printNode(step.expr)} -> ${ppLVorRV(step.val)}`;
        } else {
            return `nyi(${step.constructor.name})`;
        }
    });

    return lines.join(`\n-----------------------------\n`);
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
