import { Location } from "./step_parser_gen";

export interface Node {
    kind: string;
    loc: Location;
}

export interface NamedNode extends Node {
    name: string;
}

export interface Identifier extends NamedNode {
    kind: "Identifier";
}

export interface Var extends NamedNode {
    kind: "Var";
}

export interface StringLiteral extends Node {
    kind: "StringLiteral";
    value: string;
}

export interface HexNumber extends Node {
    kind: "HexNumber";
    value: bigint;
}

export interface DecNumber extends Node {
    kind: "DecNumber";
    value: bigint;
}

export interface Bool extends Node {
    kind: "Bool";
    value: boolean;
}

export type ExpressionNode = StringLiteral | HexNumber | DecNumber | Var | Bool;

export interface Deploy extends Node {
    kind: "Deploy";
    contract: string;
    args: ExpressionNode[];
    name?: Var;
}

export interface Call extends Node {
    kind: "Call";
    contract: HexNumber | Var;
    method: string;
    args: ExpressionNode[];
}

export type StepNode = Call | Deploy;
