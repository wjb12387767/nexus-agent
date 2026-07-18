/**
 * NAPI 调用封装：把 `@oh-my-pi/pi-natives` 的 `parseBashCommand` 包成
 * OpenClaude 风格的 `parseCommand(cmd)` → `BashNode | null | PARSE_ABORTED`。
 *
 * 语义：
 * - 空命令 / 超长命令（>10000）→ `null`（对应 OpenClaude 的"module not loaded"）
 * - NAPI 调用抛错 → `PARSE_ABORTED`（fail-closed，调用方走 aborted 分支）
 * - Rust 侧 `result.aborted === true`（超时 / 超 node budget / 超长）→ `PARSE_ABORTED`
 * - 否则 → `result.root_node`（可能为 null，例如纯空白命令）
 *
 * 向后兼容：当 `parseBashCommand` 未导出或 NAPI 模块加载失败（例如 Windows
 * 无 cargo 工具链，native addon 未构建）时，使用 `require()` + try/catch 懒加载，
 * 避免模块加载异常向上抛出。此时 `parseBashCommand` 为 `null`，`parseCommand`
 * 返回 `PARSE_ABORTED`，调用方走 aborted 分支 fall back 到正则。
 */

import type { BashAstResult, BashNode } from "./types.js";

/**
 * 懒加载的 NAPI 函数引用。
 * - `undefined`：尚未尝试加载
 * - `null`：加载失败（模块未找到 / native addon 未构建 / 函数未导出）
 * - `function`：加载成功
 *
 * 使用 `require()` 而非静态 `import`，因为 `@oh-my-pi/pi-natives` 的
 * `index.js` 在顶层调用 `loadNative()`，native addon 缺失时会抛错。
 * 静态 import 会让异常向上传播导致整个 bash-ast 包不可用，破坏
 * "NAPI 不可用时降级到正则"的向后兼容契约。
 */
let _parseBashCommand: ((command: string) => BashAstResult) | null | undefined;

function getParseBashCommand(): ((command: string) => BashAstResult) | null {
	if (_parseBashCommand === undefined) {
		try {
			// Bun 支持 ESM 中使用 require；包裹 try/catch 捕获 native addon
			// 加载失败（loadNative() 顶层抛错）或函数未导出的情况。
			const mod = require("@oh-my-pi/pi-natives") as {
				parseBashCommand?: (command: string) => BashAstResult;
			};
			_parseBashCommand = mod.parseBashCommand ?? null;
		} catch {
			_parseBashCommand = null;
		}
	}
	return _parseBashCommand;
}

/** 命令字符串最大长度（与 Rust 侧 `MAX_COMMAND_LENGTH` 对齐）。 */
const MAX_COMMAND_LENGTH = 10_000;

/**
 * SECURITY 哨兵：表示"解析器已加载但解析被 abort"
 * （超时 / 超 node budget / Rust panic / NAPI 抛错）。
 *
 * 与 `null` 区分：`null` 表示命令为空或超长（不进入解析器，调用方可走
 * 简单路径），`PARSE_ABORTED` 表示对抗性输入可能触发了预算耗尽，调用方
 * 必须 fail-closed 走 aborted 分支。
 */
export const PARSE_ABORTED = Symbol("parse-aborted");

/** parseCommand 的返回类型。 */
export type ParseResult = BashNode | null | typeof PARSE_ABORTED;

/**
 * 解析 bash 命令字符串，返回 AST 根节点或哨兵。
 *
 * 同步调用：Rust 侧 `parse_bash_command` 是同步 NAPI 函数，不存在 Promise
 * 等待；这层封装纯粹是字段名适配 + fail-closed 哨兵转换。
 */
export function parseCommand(command: string): ParseResult {
	// 空命令或超长命令：直接返回 null（不进入解析器，避免 NAPI 跨界开销）
	if (!command || command.length > MAX_COMMAND_LENGTH) return null;

	// 懒加载 NAPI 函数；加载失败 → fail-closed 视为 aborted
	const parseBashCommand = getParseBashCommand();
	if (parseBashCommand === null) return PARSE_ABORTED;

	let result: BashAstResult;
	try {
		result = parseBashCommand(command);
	} catch {
		// NAPI 调用失败（模块未加载 / Rust panic）→ fail-closed 视为 aborted
		return PARSE_ABORTED;
	}

	// Rust 侧已判定 aborted（超时 / 超 node budget / 命令超长 fallback）
	if (result.aborted) return PARSE_ABORTED;
	return result.root_node;
}
