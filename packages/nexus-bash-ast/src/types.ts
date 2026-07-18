/**
 * Nexus bash-ast 类型定义。
 *
 * 这些类型与 `crates/pi-natives/src/bash_ast.rs` 中 `#[napi(object)]` 暴露给
 * JavaScript 的 Rust struct 一一对应。字段名遵循 Rust 侧的 snake_case，
 * 而非 tree-sitter Node 的 camelCase（如 `node_type` 而非 `type`）。
 */

/** 安全分析结果分类。 */
export type SecurityVerdict =
	| "safe" // 命令安全，可直接执行（已提取所有 SimpleCommand）
	| "needs-approval" // 需要用户批准（包含 walker 不能静态分析的结构）
	| "aborted"; // AST 解析失败，调用方应 fall back 到正则方案

/**
 * AST 节点（对应 Rust 的 `BashNode`）。
 *
 * 注意：与 OpenClaude 使用的 tree-sitter `Node` 不同，这里是纯 JSON 结构，
 * 没有方法。字段映射：
 * - `node.type`     → `node.node_type`
 * - `node.text`     → `node.text`
 * - `node.startIndex` → `node.start_byte`
 * - `node.endIndex`   → `node.end_byte`
 * - `node.children` → `node.children`（数组，非迭代器）
 */
export interface BashNode {
	node_type: string;
	text: string;
	start_byte: number;
	end_byte: number;
	start_row: number;
	start_col: number;
	end_row: number;
	end_col: number;
	children: BashNode[];
}

/** 解析结果（对应 Rust 的 `BashAstResult`）。 */
export interface BashAstResult {
	root_node: BashNode | null;
	aborted: boolean;
	node_count: number;
	parse_time_ms: number;
}

/** 安全分析结果。 */
export interface ParseForSecurityResult {
	verdict: SecurityVerdict;
	/** 触发 needs-approval / aborted 的原因（如有）。 */
	reason?: string;
	/** 解析到的命令列表（用于审计与下游权限匹配）。 */
	commands: SimpleCommand[];
	/** 是否因解析失败而 aborted。 */
	aborted: boolean;
	/** 触发 needs-approval 的节点类型（诊断用，可选）。 */
	nodeType?: string;
}

/** 解析出的简单命令。 */
export interface SimpleCommand {
	/** argv[0] 是命令名，其余是参数（引号已解析）。 */
	argv: string[];
	/** 前置 VAR=val 赋值（命令局部 env）。 */
	envVars: string[];
	/** 输入/输出重定向。 */
	redirects: Redirect[];
}

/** 重定向操作。 */
export interface Redirect {
	op: string;
	target: string;
}
