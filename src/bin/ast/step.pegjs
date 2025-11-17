{
    // Dummy uses to silence unused function TSC errors in auto-generated code
    expected;
    error;
}

Step
    = Deploy
    / Call

Deploy = "deploy:" __ Contract: Identifier __ Args: CallArgs __ Name: ("@" name: Var { return name; })?  { return { kind: "Deploy", contract: Contract.name, args: Args, loc: location(), name: Name } }
Call = "call:" __ Method: MethodId __ Args: CallArgs { return { kind: "Call", contract: Method.contract, method: Method.method, args: Args, loc: location() }; }

MethodId = Contract: ContractId "." Method: Identifier { return { kind: "MethodId", contract: Contract, method: Method.name, loc: location() }; }
ContractId = HexDigit / Var

ExpressionList = head: Expression __ tail: ( __ "," __ Expression )* {
    return tail.reduce((acc, el) => { acc.push(el); return acc; }, [head]);
}

CallArgs = "(" __ es: ExpressionList? __  ")" { return es === null ? [] : es; }

Expression
    = StringLiteral
    / Number
    / Bool
    / Var

Var = "$" Identifier { return { kind: "Var", name: text(), loc: location() }}

Identifier =
    id: ([a-zA-Z$_][a-zA-Z$0-9_]*) { return { kind: "Identifier", name: text(), loc: location() }; }

// ==== Literals

StringLiteral =
    "'" chars: SingleStringChar* "'" { return { kind: "StringLiteral", value: chars.join(""), loc: location() }; }
    / '"' chars: DoubleStringChar* '"' { return { kind: "StringLiteral", value: chars.join(""), loc: location() }; }

AnyChar =
    .

DoubleStringChar =
    !('"' / "\\" / LineTerminator) AnyChar { return text(); }
    / "\\" sequence: EscapeSequence { return sequence; }
    / LineContinuation

SingleStringChar =
    !("'" / "\\" / LineTerminator) AnyChar { return text(); }
    / "\\" sequence: EscapeSequence { return sequence; }
    / LineContinuation

LineContinuation =
    "\\" LineTerminatorSequence { return ""; }

LineTerminator =
    [\n\r\u2028\u2029]

LineTerminatorSequence =
    "\n"
    / "\r\n"
    / "\r"
    / "\u2028"
    / "\u2029"

EscapeSequence =
    CharEscapeSequence
    / "0" !DecDigit { return "\0"; }
    / HexEscapeSequence
    / UnicodeEscapeSequence
    / AnyChar // Allow invalid hex sequences as a fallback

CharEscapeSequence =
    SingleEscapeChar
    / NonEscapeChar

SingleEscapeChar =
    "'"
    / '"'
    / "\\"
    / "b"  { return "\b"; }
    / "f"  { return "\f"; }
    / "n"  { return "\n"; }
    / "r"  { return "\r"; }
    / "t"  { return "\t"; }
    / "v"  { return "\v"; }

NonEscapeChar =
    !(EscapeChar / LineTerminator) AnyChar { return text(); }

HexDigit =
    [0-9a-f]i

DecDigit =
    [0-9]

EscapeChar =
    SingleEscapeChar
    / DecDigit
    / "x"
    / "u"

HexEscapeSequence =
    "x" digits:$(HexDigit HexDigit) {
        return String.fromCharCode(parseInt(digits, 16));
    }

UnicodeEscapeSequence =
    "u" digits:$(HexDigit HexDigit HexDigit HexDigit) {
        return String.fromCharCode(parseInt(digits, 16));
    }

// Numberic literals

HexNumber =
    "0x"i digits: HexDigit+ { return { kind: "HexNumber", value: BigInt(text()), loc: location() } }

DecNumber =
    [+-]? DecDigit+ { return { kind: "DecNumber", value: BigInt(text()), loc: location() } }

Number =
    value: (HexNumber / DecNumber)

Bool = "true" / "false" { return {kind: "Bool", value: text() == "true", loc: location() }}

__ =
    (PrimitiveWhiteSpace / LineTerminator)*

PrimitiveWhiteSpace =
    "\t"
    / "\v"
    / "\f"
    / " "
    / "\u00A0"
    / "\uFEFF"
    / Zs

// Separator, Space
Zs =
    [\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]