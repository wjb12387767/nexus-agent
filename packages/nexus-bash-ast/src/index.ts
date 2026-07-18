/**
 * @nexus-agent/bash-ast 主入口。
 *
 * 移植自 OpenClaude `src/utils/bash/ast.ts` 的 security walker，操作
 * `@oh-my-pi/pi-natives` 暴露的纯 JSON `BashNode` AST。
 */

export { PARSE_ABORTED, parseCommand } from "./parser.js";
export type { ParseResult } from "./parser.js";

export {
	DANGEROUS_TYPES,
	EVAL_LIKE_BUILTINS,
	parseForSecurity,
	parseForSecurityFromAst,
} from "./walker.js";

export type {
	BashAstResult,
	BashNode,
	ParseForSecurityResult,
	Redirect,
	SecurityVerdict,
	SimpleCommand,
} from "./types.js";
