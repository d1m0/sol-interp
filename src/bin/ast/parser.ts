import { StepNode } from "./nodes";
import { parse } from "./step_parser_gen";

export type ParsedStep = StepNode;
export function parseStep(contents: string): ParsedStep {
    return parse(contents);
}
