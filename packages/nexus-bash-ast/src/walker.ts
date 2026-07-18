/**
 * Security walker 核心 — 移植自 OpenClaude `src/utils/bash/ast.ts`。
 *
 * 设计原则（与 OpenClaude 一致）：
 * 1. **fail-closed**：walker 维护一个 EXPLICIT allowlist；任何不在 allowlist
 *    的节点类型都触发 `needs-approval`。
 * 2. **varScope 跟踪**：`Map<string, string>` 记录 `VAR=val` 赋值，让后续
 *    `$VAR` 引用可以解析为字面量或 `__TRACKED_VAR__` 占位符。
 * 3. **pipeline varScope 快照语义**：`||` / `|` / `|&` / `&` 分支不继承
 *    varScope 修改（subshell / 条件执行语义）。
 * 4. **declare -n nameref 检测**：`declaration_command` 的参数含 `-n` 时
 *    标记 needs-approval（nameref 改变 `$X` 解析语义）。
 * 5. **EVAL_LIKE_BUILTINS**：`eval` / `source` / `exec` / `trap` 等把参数
 *    当代码执行的 builtin，标记 needs-approval。
 *
 * 与 OpenClaude 的差异：
 * - 节点字段名：OpenClaude 用 `node.type` / `node.startIndex` / `node.endIndex`，
 *   nexus 用 `node.node_type` / `node.start_byte` / `node.end_byte`（与
 *   `crates/pi-natives/src/bash_ast.rs` 的 `#[napi(object)]` 对齐）。
 * - BashNode 是纯 JSON，没有 tree-sitter Node 的方法（`.walk()` 等）。
 *   `node.children` 直接是数组，用 `for...of` 迭代。
 * - 返回类型：OpenClaude 用 discriminated union
 *   `{ kind: 'simple' | 'too-complex' | 'parse-unavailable' }`，
 *   nexus 用 `{ verdict, reason?, commands, aborted }`。
 */

import type { BashNode, ParseForSecurityResult, Redirect, SimpleCommand } from "./types.js";
import { PARSE_ABORTED, parseCommand } from "./parser.js";

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * `$()` 输出在 outer argv 中的占位符。实际值运行时才确定；inner 命令已被
 * 单独提取到 commands[]，下游权限规则必须同时匹配 outer 和 inner。
 */
const CMDSUB_PLACEHOLDER = "__CMDSUB_OUTPUT__";

/**
 * 已跟踪变量（loop var / read var / `$()` 输出等运行时不可知值）的占位符。
 * 在 `"..."` 内部使用是安全的；作为 bare arg 会触发 needs-approval。
 */
const VAR_PLACEHOLDER = "__TRACKED_VAR__";

/**
 * 检测值是否包含任何占位符（精确或子串）。用于 `varScope` 合并时判断
 * 结果是否仍为字面量。复合值如 `VAR="prefix$(cmd)"` 会被子串检查捕获。
 */
function containsAnyPlaceholder(value: string): boolean {
	return value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER);
}

/**
 * 未加引号的 `$VAR` 在 bash 中会按 `$IFS` 分词并做通配符展开。包含这些
 * 元字符的值不能作为 bare arg 信任：`VAR="-rf /" && rm $VAR` → bash 执行
 * `rm -rf /`（两个参数），但我们的 argv 会是 `['rm', '-rf /']`（一个参数）。
 *
 * 在 `"..."` 内部，分词与通配都不发生 —— 值就是单个字面量参数。
 */
const BARE_VAR_UNSAFE_RE = /[ \t\n*?[]/;

/**
 * bash 自动设置的安全环境变量。值由 shell/OS 控制，不是任意用户输入。
 * 引用这些 `$VAR` 是安全的 —— 展开是确定的，不会引入注入风险。
 */
const SAFE_ENV_VARS = new Set([
	"HOME",
	"PWD",
	"OLDPWD",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"HOSTNAME",
	"UID",
	"EUID",
	"PPID",
	"RANDOM",
	"SECONDS",
	"LINENO",
	"TMPDIR",
	"BASH_VERSION",
	"BASHPID",
	"SHLVL",
	"HISTFILE",
	"IFS",
]);

/**
 * 特殊 shell 变量（`$?` / `$$` / `$!` / `$#` / `$0`-`$9`）。
 * tree-sitter 用 `special_variable_name` 节点表示这些（不是 `variable_name`）。
 * 值由 shell 控制，仅在 `"..."` 内部解析为 VAR_PLACEHOLDER 安全。
 *
 * SECURITY：`@` 和 `*` 不在此集合中。在 `"..."` 内部它们展开为位置参数，
 * 在新启动的 BashTool shell 中为空，会让 argv 与 bash 实际行为不一致。
 */
const SPECIAL_VAR_NAMES = new Set(["?", "$", "!", "#", "0", "-"]);

/**
 * 已知危险的节点类型：表示"该命令无法静态分析"。
 * 这些类型要么执行任意代码（substitution / subshell / 控制流），
 * 要么展开为静态不可定的值（参数展开 / 算术展开 / 花括号展开）。
 *
 * 此集合并非穷举 —— 真正的安全保证来自 walker 中的 allowlist：
 * 任何未显式处理的类型也触发 needs-approval。
 */
export const DANGEROUS_TYPES = new Set<string>([
	"command_substitution",
	"process_substitution",
	"expansion",
	"simple_expansion",
	"brace_expression",
	"subshell",
	"compound_statement",
	"for_statement",
	"while_statement",
	"until_statement",
	"if_statement",
	"case_statement",
	"function_definition",
	"test_command",
	"ansi_c_string",
	"translated_string",
	"herestring_redirect",
	"heredoc_redirect",
	// nameref 相关：declaration_command 由专门分支处理，此处仅作记录
	"declaration_command",
	// 补充其他危险类型（与 OpenClaude L186-208 对齐 + 任务要求补的几项）
	"array",
	"array_reference",
	"subscript",
	"heredoc_body",
	"herestring",
	"regex",
	"extglob_pattern",
	"brace_pattern",
	"ternary_expression",
]);

/** 结构性节点类型：表示命令的组合关系，walker 递归进入。 */
const STRUCTURAL_TYPES = new Set([
	"program",
	"list",
	"pipeline",
	"redirected_statement",
]);

/** 分隔符 token：出现在 list / pipeline / program 子节点间，无 payload。 */
const SEPARATOR_TYPES = new Set(["&&", "||", "|", ";", "&", "|&", "\n"]);

/** 重定向操作符 token → 规范化操作符。 */
const REDIRECT_OPS: Record<string, Redirect["op"]> = {
	">": ">",
	">>": ">>",
	"<": "<",
	">&": ">&",
	"<&": "<&",
	">|": ">|",
	"&>": "&>",
	"&>>": "&>>",
	"<<<": "<<<",
};

/** 花括号展开模式：`{a,b}` 或 `{a..b}`。 */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/;

/** 控制字符：bash 静默丢弃但 tree-sitter 视为分隔符，导致分词差异。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/;

/** Unicode 不可见空白：终端看不到，bash 视为字面字符。 */
const UNICODE_WHITESPACE_RE =
	/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

/** 反斜杠 + 空白：bash 视为字面空格，tree-sitter 保留反斜杠。 */
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/;

/** zsh `~[name]` 动态命名目录展开（可能执行 hook 代码）。 */
const ZSH_TILDE_BRACKET_RE = /~\[/;

/** zsh `=cmd` 等号展开（展开为命令绝对路径）。 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/;

/** 花括号 + 引号字符：可能是花括号展开混淆。 */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/;

/** 算术展开的叶子节点允许字符（数字 / 标识符 / 运算符）。 */
const ARITH_LEAF_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^[0-9]+$/;

/** argv / envVar / redirect target 中的 `\n#`：下游 stripSafeWrappers 会误当注释。 */
const NEWLINE_HASH_RE = /\n[ \t]*#/;

/** 单字符 `$`，用于 walkString 中处理裸 `$`。 */
const DOLLAR = String.fromCharCode(0x24);

// ───────────────────────────── builtin 黑名单 ─────────────────────────────

/**
 * Zsh 模块 builtin：不是 PATH 上的二进制，而是 zsh 内部通过 zmodload 加载。
 * BashTool 通过用户默认 shell（通常是 zsh）运行，这些会作为普通 `command`
 * 节点出现，只能按名匹配。
 */
const ZSH_DANGEROUS_BUILTINS = new Set([
	"zmodload",
	"emulate",
	"sysopen",
	"sysread",
	"syswrite",
	"sysseek",
	"zpty",
	"ztcp",
	"zsocket",
	"zf_rm",
	"zf_mv",
	"zf_ln",
	"zf_chmod",
	"zf_chown",
	"zf_mkdir",
	"zf_rmdir",
	"zf_chgrp",
]);

/**
 * 把参数当代码执行的 shell builtin。`eval "rm -rf /"` 的 argv 看起来无害，
 * 但会执行字符串内容。walker 提取 argv 后由 checkSemantics 检测这些 builtin
 * 并标记 needs-approval。
 */
export const EVAL_LIKE_BUILTINS = new Set([
	"eval",
	"source",
	".",
	"exec",
	"command",
	"builtin",
	"fc",
	"coproc",
	"noglob",
	"nocorrect",
	"trap",
	"enable",
	"mapfile",
	"readarray",
	"hash",
	"bind",
	"complete",
	"compgen",
	"alias",
	"let",
]);

// ───────────────────────────── 主入口 ─────────────────────────────

/**
 * 解析 bash 命令字符串并做安全分析。
 *
 * 流程：
 * 1. `parseCommand(cmd)` 调用 NAPI 解析。
 * 2. 若返回 `PARSE_ABORTED` → verdict=aborted。
 * 3. 若返回 `null`（空命令 / 超长 / NAPI 不可用）→ verdict=safe, commands=[]。
 * 4. 否则调用 `parseForSecurityFromAst(cmd, root)`。
 */
export function parseForSecurity(cmd: string): ParseForSecurityResult {
	// 空命令直接返回 safe + 空 commands（与 OpenClaude 一致）
	if (cmd === "") return { verdict: "safe", commands: [], aborted: false };

	const root = parseCommand(cmd);

	if (root === PARSE_ABORTED) {
		return {
			verdict: "aborted",
			reason:
				"Parser aborted (timeout or resource limit) — possible adversarial input",
			commands: [],
			aborted: true,
		};
	}

	if (root === null) {
		// 命令超长或 NAPI 模块未加载 → 调用方应 fall back 到正则
		return {
			verdict: "aborted",
			reason: "Parser unavailable (command too long or module not loaded)",
			commands: [],
			aborted: true,
		};
	}

	return parseForSecurityFromAst(cmd, root);
}

/**
 * 对已解析的 AST 跑 security walker。先做 pre-checks（tree-sitter/bash 分词
 * 差异），再调用 `walkProgram`。
 */
export function parseForSecurityFromAst(
	cmd: string,
	root: BashNode | typeof PARSE_ABORTED,
): ParseForSecurityResult {
	// Pre-checks：捕获 tree-sitter 与 bash 在分词上的已知差异。
	if (CONTROL_CHAR_RE.test(cmd)) {
		return tooComplex("Contains control characters");
	}
	if (UNICODE_WHITESPACE_RE.test(cmd)) {
		return tooComplex("Contains Unicode whitespace");
	}
	if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
		return tooComplex("Contains backslash-escaped whitespace");
	}
	if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
		return tooComplex("Contains zsh ~[ dynamic directory syntax");
	}
	if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
		return tooComplex("Contains zsh =cmd equals expansion");
	}
	if (BRACE_WITH_QUOTE_RE.test(maskBracesInQuotedContexts(cmd))) {
		return tooComplex("Contains brace with quote character (expansion obfuscation)");
	}

	const trimmed = cmd.trim();
	if (trimmed === "") {
		return { verdict: "safe", commands: [], aborted: false };
	}

	if (root === PARSE_ABORTED) {
		return {
			verdict: "aborted",
			reason:
				"Parser aborted (timeout or resource limit) — possible adversarial input",
			commands: [],
			aborted: true,
		};
	}

	return walkProgram(root);
}

// 内部：parseCommand 已在文件顶部 import，此处无需重复导入。

/**
 * 入口：递归遍历 program 根节点，收集 SimpleCommand。
 * 任何未处理的节点类型 → needs-approval。
 */
function walkProgram(root: BashNode): ParseForSecurityResult {
	const commands: SimpleCommand[] = [];
	// 跟踪同一条命令内先前赋值的变量。`simple_expansion` ($VAR) 引用已跟踪
	// 变量时，可替换为占位符或字面量，避免一概 needs-approval。
	const varScope = new Map<string, string>();
	const err = collectCommands(root, commands, varScope);
	if (err) return err;
	return { verdict: "safe", commands, aborted: false };
}

// ───────────────────────────── collectCommands ─────────────────────────────

/**
 * 递归收集叶子 `command` 节点。返回 `ParseForSecurityResult | null`：
 * - null 表示成功（commands 已填充）
 * - 非 null 表示出错（needs-approval / aborted）
 */
function collectCommands(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	switch (node.node_type) {
		case "command":
			return walkCommand(node, [], commands, varScope);

		case "redirected_statement":
			return walkRedirectedStatement(node, commands, varScope);

		case "comment":
			return null;

		case "negated_command": {
			// `! cmd` 仅反转退出码，不执行代码。递归到内部 command。
			for (const child of node.children) {
				if (child.node_type === "!") continue;
				return collectCommands(child, commands, varScope);
			}
			return null;
		}

		case "declaration_command":
			return walkDeclarationCommand(node, commands, varScope);

		case "variable_assignment": {
			// 顶层 `VAR=value`（非 command 前缀）。设置 shell 变量，无代码执行。
			// 值由 walkVariableAssignment → walkArgument 校验，`VAR=$(evil)` 仍会
			// 递归提取/reject 内部命令。不 push 到 commands（裸赋值无需权限规则）。
			const ev = walkVariableAssignment(node, commands, varScope);
			if (typeof ev !== "object" || !("name" in ev)) return ev as ParseForSecurityResult;
			applyVarToScope(varScope, ev);
			return null;
		}

		case "for_statement":
			return walkForStatement(node, commands, varScope);

		case "if_statement":
		case "while_statement":
		case "until_statement":
			return walkIfOrWhile(node, commands, varScope);

		case "subshell": {
			// `(cmd1; cmd2)` 在子 shell 中运行。内部命令仍要执行，提取做权限检查。
			// 子 shell 隔离作用域：内部赋值不外泄。用 varScope 副本递归。
			const innerScope = new Map(varScope);
			for (const child of node.children) {
				if (child.node_type === "(" || child.node_type === ")") continue;
				const err = collectCommands(child, commands, innerScope);
				if (err) return err;
			}
			return null;
		}

		case "compound_statement": {
			// `{ cmd1; cmd2; }` 在当前 shell 中运行（不像 subshell 隔离作用域）。
			// 内部赋值会泄漏到外部，使用真实 varScope。
			for (const child of node.children) {
				if (child.node_type === "{" || child.node_type === "}") continue;
				const err = collectCommands(child, commands, varScope);
				if (err) return err;
			}
			return null;
		}

		case "test_command":
			return walkTestCommand(node, commands, varScope);

		case "unset_command":
			return walkUnsetCommand(node, commands, varScope);

		default:
			if (STRUCTURAL_TYPES.has(node.node_type)) {
				return walkStructural(node, commands, varScope);
			}
			return tooComplexNode(node);
	}
}

// ───────────────────────────── structural walker ─────────────────────────────

/**
 * 处理 program / list / pipeline：递归子节点，根据分隔符管理 varScope 快照。
 *
 * SECURITY：`||` / `|` / `|&` / `&` 分支不能线性继承 varScope：
 * - `||` RHS 条件执行 → 那里的赋值可能不发生
 * - `|` / `|&` 各阶段在子 shell 中 → 赋值永远不外泄
 * - `&` LHS 在后台子 shell → 同上
 *
 * Flag-omission 攻击示例：`true || FLAG=--dry-run && cmd $FLAG`
 * bash 跳过 `||` RHS（FLAG 未设 → $FLAG 为空），运行 `cmd` 不带 --dry-run。
 * 若线性继承，argv 会是 `['cmd','--dry-run']` → 看起来安全 → 绕过。
 *
 * 修复：进入这些分隔符时，重置 scope 为入口快照。`&&` 和 `;` 仍线性继承
 * （顺序执行，VAR=x && cmd $VAR 中 VAR 已设）。
 */
function walkStructural(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const isPipeline = node.node_type === "pipeline";
	// 预扫描：是否含 `||` 或 `&` 分隔符（决定是否需要快照）
	let needsSnapshot = false;
	if (!isPipeline) {
		for (const c of node.children) {
			if (c.node_type === "||" || c.node_type === "&") {
				needsSnapshot = true;
				break;
			}
		}
	}
	const snapshot = needsSnapshot ? new Map(varScope) : null;
	// pipeline：所有阶段在子 shell 中 → 用副本，不污染 caller
	// list/program：`&&`/`;` 链顺序执行 → 用真实 varScope，仅在 `||`/`&` 时 fork
	let scope = isPipeline ? new Map(varScope) : varScope;

	for (const child of node.children) {
		if (SEPARATOR_TYPES.has(child.node_type)) {
			if (
				child.node_type === "||" ||
				child.node_type === "|" ||
				child.node_type === "|&" ||
				child.node_type === "&"
			) {
				// 重置 scope 到入口快照（pipeline 用入口副本；list/program 用 snapshot）
				scope = new Map(snapshot ?? varScope);
			}
			continue;
		}
		const err = collectCommands(child, commands, scope);
		if (err) return err;
	}
	return null;
}

// ───────────────────────────── command walker ─────────────────────────────

/**
 * 处理 `command` 节点，提取 argv。
 *
 * 子节点顺序：[variable_assignment...] command_name [argument...] [file_redirect...]
 * 任何未显式处理的子节点类型 → needs-approval。
 */
function walkCommand(
	node: BashNode,
	extraRedirects: Redirect[],
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const argv: string[] = [];
	const envVars: string[] = [];
	const redirects: Redirect[] = [...extraRedirects];

	for (const child of node.children) {
		switch (child.node_type) {
			case "variable_assignment": {
				const ev = walkVariableAssignment(child, innerCommands, varScope);
				if (typeof ev !== "object" || !("name" in ev)) return ev as ParseForSecurityResult;
				// SECURITY：env-prefix 赋值（`VAR=x cmd`）是 command-local 的，
				// VAR 仅对 cmd 可见，不外泄。不能加到 varScope，否则
				// `VAR=safe cmd1 && rm $VAR` 会错误解析 $VAR。
				envVars.push(`${ev.name}=${ev.value}`);
				break;
			}
			case "command_name": {
				// command_name 的第一个子节点是实际的 name 节点
				const nameChild = child.children[0] ?? child;
				const arg = walkArgument(nameChild, innerCommands, varScope);
				if (typeof arg !== "string") return arg;
				argv.push(arg);
				break;
			}
			case "word":
			case "number":
			case "raw_string":
			case "string":
			case "concatenation":
			case "arithmetic_expansion": {
				const arg = walkArgument(child, innerCommands, varScope);
				if (typeof arg !== "string") return arg;
				argv.push(arg);
				break;
			}
			case "simple_expansion": {
				// 裸 `$VAR` 作为参数。已跟踪的静态变量返回实际值（VAR=/etc → '/etc'）。
				// 含 IFS/glob 字符或占位符的值 → needs-approval。
				const v = resolveSimpleExpansion(child, varScope, false);
				if (typeof v !== "string") return v;
				argv.push(v);
				break;
			}
			case "file_redirect": {
				const r = walkFileRedirect(child, innerCommands, varScope);
				if (typeof r !== "object" || !("op" in r)) return r as ParseForSecurityResult;
				redirects.push(r);
				break;
			}
			case "herestring_redirect": {
				const err = walkHerestringRedirect(child, innerCommands, varScope);
				if (err) return err;
				break;
			}
			default:
				return tooComplexNode(child);
		}
	}

	const simple: SimpleCommand = { argv, envVars, redirects };
	// checkSemantics 在收集后做 builtin 黑名单匹配
	const semErr = checkSemantics(simple);
	if (semErr) return semErr;
	innerCommands.push(simple);
	return null;
}

// ───────────────────────────── declaration_command walker ─────────────────────────────

/**
 * 处理 `export` / `local` / `readonly` / `declare` / `typeset`。
 *
 * SECURITY：`declare` / `typeset` / `local` 的 `-n`（nameref）、`-i`（integer）、
 * `-a`/`-A`（array）flag 改变赋值语义，破坏静态模型 → needs-approval。
 * - `-n X=Y`：`$X` 解引用为 `$Y` 的值，varScope 存 'Y'（target NAME），argv[0]
 *   显示 'Y' 而 bash 运行 $Y 的内容。
 * - `-i X='a[$(cmd)]'`：赋值时算术求值 RHS，即使 single-quoted 也运行 $(cmd)。
 * - `-a`/`-A`：下标赋值触发算术求值。
 *
 * `export -n` 表示"取消 export 属性"（不是 nameref），export/readonly 不接受
 * `-i`，readonly -a/-A 拒绝下标参数 → 仅对 declare/typeset/local 检查这些 flag。
 */
function walkDeclarationCommand(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const argv: string[] = [];

	for (const child of node.children) {
		switch (child.node_type) {
			case "export":
			case "local":
			case "readonly":
			case "declare":
			case "typeset":
				argv.push(child.text);
				break;

			case "word":
			case "number":
			case "raw_string":
			case "string":
			case "concatenation": {
				const arg = walkArgument(child, commands, varScope);
				if (typeof arg !== "string") return arg;
				// nameref / integer / array flag 检测
				if (
					(argv[0] === "declare" ||
						argv[0] === "typeset" ||
						argv[0] === "local") &&
					/^-[a-zA-Z]*[niaA]/.test(arg)
				) {
					return tooComplex(
						`declare flag ${arg} changes assignment semantics (nameref/integer/array)`,
						"declaration_command",
					);
				}
				// SECURITY：裸位置参数带下标也会算术求值 —— 无需 -a/-i flag。
				// `declare 'x[$(id)]=val'` 隐式创建数组元素，算术求值下标，运行 $(id)。
				if (
					(argv[0] === "declare" ||
						argv[0] === "typeset" ||
						argv[0] === "local") &&
					arg[0] !== "-" &&
					/^[^=]*\[/.test(arg)
				) {
					return tooComplex(
						`declare positional '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
						"declaration_command",
					);
				}
				argv.push(arg);
				break;
			}

			case "variable_assignment": {
				const ev = walkVariableAssignment(child, commands, varScope);
				if (typeof ev !== "object" || !("name" in ev)) return ev as ParseForSecurityResult;
				// export/declare 赋值填充 scope，后续 $VAR 引用可解析
				applyVarToScope(varScope, ev);
				argv.push(`${ev.name}=${ev.value}`);
				break;
			}

			case "variable_name":
				// `export FOO` — 裸名，无赋值
				argv.push(child.text);
				break;

			default:
				return tooComplexNode(child);
		}
	}

	const simple: SimpleCommand = { argv, envVars: [], redirects: [] };
	const semErr = checkSemantics(simple);
	if (semErr) return semErr;
	commands.push(simple);
	return null;
}

// ───────────────────────────── variable_assignment walker ─────────────────────────────

/**
 * 处理 `variable_assignment` 节点，返回 `{ name, value, isAppend }` 或
 * needs-approval 结果。
 *
 * SECURITY：
 * - 变量名必须是 `[A-Za-z_][A-Za-z0-9_]*`，否则 bash 视为命令执行。
 * - `IFS` 赋值改变后续 `$VAR` 分词行为 → reject。
 * - `PS4` 赋值在 `set -x` 后每次 trace 都会 promptvars 展开 → 严格 allowlist。
 * - `+=`（append）+ PS4 → reject（无法静态推导有效值）。
 * - 值含 `~` → reject（bash 可能在赋值时展开 tilde）。
 */
function walkVariableAssignment(
	node: BashNode,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
):
	| { name: string; value: string; isAppend: boolean }
	| ParseForSecurityResult {
	let name: string | null = null;
	let value = "";
	let isAppend = false;

	for (const child of node.children) {
		if (child.node_type === "variable_name") {
			name = child.text;
		} else if (child.node_type === "=" || child.node_type === "+=") {
			isAppend = child.node_type === "+=";
		} else if (child.node_type === "command_substitution") {
			// $() 作为变量值：输出成为字符串存入变量，不是位置参数（无路径/flag 风险）。
			// inner command 单独提取做权限检查；变量值用 CMDSUB_PLACEHOLDER。
			const err = collectCommandSubstitution(child, innerCommands, varScope);
			if (err) return err;
			value = CMDSUB_PLACEHOLDER;
		} else if (child.node_type === "simple_expansion") {
			// `VAR=$OTHER` —— 赋值 RHS 不分词、不通配（与命令参数不同）。
			// 按 insideString=true 解析，避免 BARE_VAR_UNSAFE_RE 过度拒绝。
			const v = resolveSimpleExpansion(child, varScope, true);
			if (typeof v !== "string") return v;
			value = v;
		} else {
			// word / raw_string / string / concatenation / array 等
			const v = walkArgument(child, innerCommands, varScope);
			if (typeof v !== "string") return v;
			value = v;
		}
	}

	if (name === null) {
		return tooComplex("Variable assignment without name", "variable_assignment");
	}

	// SECURITY：tree-sitter-bash 接受 `1VAR=value` 为 variable_assignment，
	// 但 bash 只识别 `[A-Za-z_][A-Za-z0-9_]*`，其他会被当命令执行。
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return tooComplex(
			`Invalid variable name (bash treats as command): ${name}`,
			"variable_assignment",
		);
	}

	// IFS 赋值改变分词 → 无法静态建模 → reject
	if (name === "IFS") {
		return tooComplex(
			"IFS assignment changes word-splitting — cannot model statically",
			"variable_assignment",
		);
	}

	// PS4 赋值在 set -x 后每次 trace 都会 promptvars 展开。
	// 用 allowlist（不是 blocklist）：reject += / placeholder，allowlist 剩余字符集。
	if (name === "PS4") {
		if (isAppend) {
			return tooComplex(
				"PS4 += cannot be statically verified — combine into a single PS4= assignment",
				"variable_assignment",
			);
		}
		if (containsAnyPlaceholder(value)) {
			return tooComplex(
				"PS4 value derived from cmdsub/variable — runtime unknowable",
				"variable_assignment",
			);
		}
		if (
			!/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
				value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""),
			)
		) {
			return tooComplex(
				"PS4 value outside safe charset — only ${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed",
				"variable_assignment",
			);
		}
	}

	// SECURITY：赋值 RHS 的 tilde 展开。`VAR=~/x` → bash 在赋值时展开 ~。
	// 我们看到字面 `~/x`，但 `cd $VAR` 会进入 `/home/user/x`。无法建模 → reject。
	if (value.includes("~")) {
		return tooComplex(
			"Tilde in assignment value — bash may expand at assignment time",
			"variable_assignment",
		);
	}

	return { name, value, isAppend };
}

// ───────────────────────────── argument walker ─────────────────────────────

/**
 * 把参数节点转为字面量字符串（引号已解析）。实现 argument-position allowlist。
 *
 * 注意：`command_substitution` 作为 bare arg 故意 NOT handled —— `$(...)` 输出
 * IS the argument，对路径敏感命令（cd/rm/chmod）来说占位符会隐藏真实路径。
 * `rm $(echo /etc)` 必须保持 needs-approval。`$()` 在 `string` 内部
 * （walkString）才会被提取，因为输出被嵌入更长字符串（更安全）。
 */
function walkArgument(
	node: BashNode | null,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): string | ParseForSecurityResult {
	if (!node) {
		return tooComplex("Null argument node");
	}

	switch (node.node_type) {
		case "word": {
			// 反斜杠转义：unquoted context 中 bash quote removal 把 `\X` → `X`。
			// tree-sitter 保留原始文本，这里展开使 argv 准确。
			if (BRACE_EXPANSION_RE.test(node.text)) {
				return tooComplex("Word contains brace expansion syntax", "word");
			}
			return node.text.replace(/\\(.)/g, "$1");
		}

		case "number":
			// SECURITY：tree-sitter-bash 把 `NN#<expansion>`（算术基语法）解析为
			// `number` 节点 + expansion 子节点。`10#$(cmd)` 的 .text 是完整字面量
			// 但子节点是 command_substitution，bash 会运行 cmd。有子节点的 number
			// 必须拒绝。
			if (node.children.length > 0) {
				return tooComplex(
					"Number node contains expansion (NN# arithmetic base syntax)",
					node.children[0]?.node_type,
				);
			}
			return node.text;

		case "raw_string":
			// 单引号字符串：内容字面，剥首尾引号即可
			return stripRawString(node.text);

		case "string":
			return walkString(node, innerCommands, varScope);

		case "concatenation": {
			if (BRACE_EXPANSION_RE.test(node.text)) {
				return tooComplex("Brace expansion", "concatenation");
			}
			let result = "";
			for (const child of node.children) {
				const part = walkArgument(child, innerCommands, varScope);
				if (typeof part !== "string") return part;
				result += part;
			}
			return result;
		}

		case "arithmetic_expansion": {
			const err = walkArithmetic(node);
			if (err) return err;
			return node.text;
		}

		case "simple_expansion": {
			// `$VAR` 在 concatenation 中（如 `prefix$VAR`）。与 walkCommand 中
			// bare case 同规则：必须已跟踪或属于 SAFE_ENV_VARS。
			return resolveSimpleExpansion(node, varScope, false);
		}

		default:
			return tooComplexNode(node);
	}
}

// ───────────────────────────── string walker ─────────────────────────────

/**
 * 解析双引号字符串节点的字面内容。`string` 节点的子节点是 `"` 分隔符、
 * `string_content` 字面量、可能的 expansion 节点。
 *
 * SECURITY：跟踪字符串是否仅含 dynamic placeholder（无字面内容）。
 * `"$(cmd)"` 会产生一个 IS placeholder 的 argv 元素，下游路径校验可能
 * 把它当 cwd 内相对文件名 → 绕过。`"prefix: $(cmd)"` 这种混合了字面内容
 * 的字符串是安全的（运行时值不可能等于裸路径）。solo-placeholder → reject。
 */
function walkString(
	node: BashNode,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): string | ParseForSecurityResult {
	let result = "";
	let cursor = -1;
	let sawDynamicPlaceholder = false;
	let sawLiteralContent = false;

	for (const child of node.children) {
		// 子节点 startIndex 间隔 = 被吃掉的新行（tree-sitter quirk）
		if (cursor !== -1 && child.start_byte > cursor && child.node_type !== '"') {
			result += "\n".repeat(child.start_byte - cursor);
			sawLiteralContent = true;
		}
		cursor = child.end_byte;

		switch (child.node_type) {
			case '"':
				// 重置 cursor 让 `"` 与首个内容子节点之间的间隔被捕获
				cursor = child.end_byte;
				break;

			case "string_content":
				// bash 双引号转义规则：仅 `\` 转义 `$` `` ` `` `"` `\`，其他 `\X` 字面保留
				result += child.text.replace(/\\([$`"\\])/g, "$1");
				sawLiteralContent = true;
				break;

			case DOLLAR:
				// 闭合引号前的裸 `$` 是字面
				result += DOLLAR;
				sawLiteralContent = true;
				break;

			case "command_substitution": {
				// `"..."` 中的 $()：递归提取内部命令做权限检查；outer argv 用
				// CMDSUB_PLACEHOLDER 占位（运行时值）。
				const err = collectCommandSubstitution(child, innerCommands, varScope);
				if (err) return err;
				result += CMDSUB_PLACEHOLDER;
				sawDynamicPlaceholder = true;
				break;
			}

			case "simple_expansion": {
				// `"$VAR"` —— 按 insideString=true 解析。
				const v = resolveSimpleExpansion(child, varScope, true);
				if (typeof v !== "string") return v;
				result += v;
				if (v === VAR_PLACEHOLDER || v === CMDSUB_PLACEHOLDER) {
					sawDynamicPlaceholder = true;
				} else {
					sawLiteralContent = true;
				}
				break;
			}

			case "arithmetic_expansion": {
				const err = walkArithmetic(child);
				if (err) return err;
				result += child.text;
				sawDynamicPlaceholder = true;
				break;
			}

			default:
				return tooComplexNode(child);
		}
	}

	// SECURITY：solo-placeholder 字符串 → reject。下游路径校验会把 placeholder
	// 解析为 cwd 内相对文件名，绕过检查。`cd "$(echo /etc)"` 必须保留 needs-approval。
	if (sawDynamicPlaceholder && !sawLiteralContent) {
		return tooComplex(
			"String consists only of dynamic placeholder — runtime value could be a path",
			"string",
		);
	}
	return result;
}

// ───────────────────────────── expansion 解析 ─────────────────────────────

/**
 * 解析 `simple_expansion`（$VAR）节点。
 *
 * @param insideString true 表示 $VAR 在 `"..."` 内部。SAFE_ENV_VARS 与
 *   未知值的已跟踪变量仅在字符串内允许 —— 作为 bare arg 时运行时值 IS the
 *   argument，静态不可知，对路径敏感命令有风险。
 */
function resolveSimpleExpansion(
	node: BashNode,
	varScope: Map<string, string>,
	insideString: boolean,
): string | ParseForSecurityResult {
	let varName: string | null = null;
	let isSpecial = false;
	for (const c of node.children) {
		if (c.node_type === "variable_name") {
			varName = c.text;
			break;
		}
		if (c.node_type === "special_variable_name") {
			varName = c.text;
			isSpecial = true;
			break;
		}
	}
	if (varName === null) return tooComplexNode(node);

	// 已跟踪变量：检查存储的值
	const trackedValue = varScope.get(varName);
	if (trackedValue !== undefined) {
		if (containsAnyPlaceholder(trackedValue)) {
			// 非字面值：bare → reject，inside string → VAR_PLACEHOLDER
			if (!insideString) return tooComplexNode(node);
			return VAR_PLACEHOLDER;
		}
		// 纯字面值（如 '/tmp', 'foo'）—— 直接返回。下游路径校验看到真实值。
		if (!insideString) {
			// SECURITY：bare arg 会 word-split + glob-expand。
			// `VAR="-rf /" && rm $VAR` → bash 运行 `rm -rf /`（两参数）。
			// `VAR="/etc/*" && cat $VAR` → glob 展开。含 IFS/glob 字符的值 reject。
			// 空值作为 bare arg 也会消失（bash 分词产生 0 个字段）→ reject。
			if (trackedValue === "") return tooComplexNode(node);
			if (BARE_VAR_UNSAFE_RE.test(trackedValue)) return tooComplexNode(node);
		}
		return trackedValue;
	}

	// SAFE_ENV_VARS + 特殊变量：值由 shell 控制，仅在字符串内允许
	if (insideString) {
		if (SAFE_ENV_VARS.has(varName)) return VAR_PLACEHOLDER;
		if (
			isSpecial &&
			(SPECIAL_VAR_NAMES.has(varName) || /^[0-9]+$/.test(varName))
		) {
			return VAR_PLACEHOLDER;
		}
	}
	return tooComplexNode(node);
}

/**
 * 把变量赋值应用到 scope，处理 `+=` append 语义。
 * SECURITY：若 existing 或 appended 任一含 placeholder，结果为非字面 →
 * 存 VAR_PLACEHOLDER，让后续 $VAR bare 引用正确 reject。
 */
function applyVarToScope(
	varScope: Map<string, string>,
	ev: { name: string; value: string; isAppend: boolean },
): void {
	const existing = varScope.get(ev.name) ?? "";
	const combined = ev.isAppend ? existing + ev.value : ev.value;
	varScope.set(
		ev.name,
		containsAnyPlaceholder(combined) ? VAR_PLACEHOLDER : combined,
	);
}

// ───────────────────────────── command_substitution ─────────────────────────────

/**
 * 递归进入 `command_substitution` 节点的内部命令。
 *
 * 若内部命令解析为 simple，追加到 innerCommands 并返回 null（成功）。
 * 否则返回 needs-approval 错误。这让 `echo $(git rev-parse HEAD)` 同时
 * 提取 outer `echo $(...)` 和 inner `git rev-parse HEAD` —— 权限规则必须
 * 同时匹配两者整个命令才允许。
 */
function collectCommandSubstitution(
	csNode: BashNode,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	// $() 内部是子 shell：外部已赋值的变量可见，内部赋值不外泄。用副本递归。
	const innerScope = new Map(varScope);
	for (const child of csNode.children) {
		if (child.node_type === "$(" || child.node_type === "`" || child.node_type === ")") {
			continue;
		}
		const err = collectCommands(child, innerCommands, innerScope);
		if (err) return err;
	}
	return null;
}

// ───────────────────────────── arithmetic ─────────────────────────────

/**
 * 校验 `arithmetic_expansion` 节点（`$(( ... ))`）。
 *
 * 当安全时，调用方把完整 `$((…))` span 作为字面量放入 argv。bash 运行时
 * 会展开为整数，静态字符串不会匹配敏感路径/deny 模式。
 */
function walkArithmetic(node: BashNode): ParseForSecurityResult | null {
	for (const child of node.children) {
		if (child.children.length === 0) {
			if (!ARITH_LEAF_RE.test(child.text)) {
				return tooComplex(
					`Arithmetic expansion references variable or non-literal: ${child.text}`,
					"arithmetic_expansion",
				);
			}
			continue;
		}
		switch (child.node_type) {
			case "binary_expression":
			case "unary_expression":
			case "ternary_expression":
			case "parenthesized_expression": {
				const err = walkArithmetic(child);
				if (err) return err;
				break;
			}
			default:
				return tooComplexNode(child);
		}
	}
	return null;
}

// ───────────────────────────── redirect walkers ─────────────────────────────

/**
 * 处理 `redirected_statement`：包裹一个 command（或 pipeline）+ 一个或多个
 * `file_redirect` / `heredoc_redirect`。提取 redirect，遍历内部 command，
 * 把 redirect 附加到 LAST command（其输出被重定向的那个）。
 */
function walkRedirectedStatement(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const redirects: Redirect[] = [];
	let innerCommand: BashNode | null = null;

	for (const child of node.children) {
		if (child.node_type === "file_redirect") {
			// redirect target 中的 $() 也要提取（`> $(mktemp)`）
			const r = walkFileRedirect(child, commands, varScope);
			if (typeof r !== "object" || !("op" in r)) return r as ParseForSecurityResult;
			redirects.push(r);
		} else if (child.node_type === "heredoc_redirect") {
			const r = walkHeredocRedirect(child);
			if (r) return r;
		} else if (
			child.node_type === "command" ||
			child.node_type === "pipeline" ||
			child.node_type === "list" ||
			child.node_type === "negated_command" ||
			child.node_type === "declaration_command" ||
			child.node_type === "unset_command"
		) {
			innerCommand = child;
		} else {
			return tooComplexNode(child);
		}
	}

	if (!innerCommand) {
		// `> file` 单独出现是合法 bash（截断文件）。用空 argv 表示写入操作。
		commands.push({ argv: [], envVars: [], redirects });
		return null;
	}

	const before = commands.length;
	const err = collectCommands(innerCommand, commands, varScope);
	if (err) return err;
	if (commands.length > before && redirects.length > 0) {
		const last = commands[commands.length - 1];
		if (last) last.redirects.push(...redirects);
	}
	return null;
}

/** 从 `file_redirect` 节点提取 operator + target。target 必须是静态 word/string。 */
function walkFileRedirect(
	node: BashNode,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): Redirect | ParseForSecurityResult {
	let op: Redirect["op"] | null = null;
	let target: string | null = null;

	for (const child of node.children) {
		if (child.node_type === "file_descriptor") {
			// fd 前缀（`2>file`），忽略 —— 规范化 op 已包含语义
			continue;
		}
		if (child.node_type in REDIRECT_OPS) {
			op = REDIRECT_OPS[child.node_type] ?? null;
		} else if (child.node_type === "word" || child.node_type === "number") {
			// SECURITY：`number` 节点可能含 expansion 子节点（`NN#<expansion>` 算术基）
			if (child.children.length > 0) return tooComplexNode(child);
			if (BRACE_EXPANSION_RE.test(child.text)) return tooComplexNode(child);
			// 反斜杠转义展开（与 walkArgument 一致）
			target = child.text.replace(/\\(.)/g, "$1");
		} else if (child.node_type === "raw_string") {
			target = stripRawString(child.text);
		} else if (child.node_type === "string") {
			const s = walkString(child, innerCommands, varScope);
			if (typeof s !== "string") return s;
			target = s;
		} else if (child.node_type === "concatenation") {
			const s = walkArgument(child, innerCommands, varScope);
			if (typeof s !== "string") return s;
			target = s;
		} else {
			return tooComplexNode(child);
		}
	}

	if (!op || target === null) {
		return tooComplex("Unrecognized redirect shape", node.node_type);
	}
	return { op, target };
}

/**
 * Heredoc redirect。仅 quoted-delimiter heredoc（`<<'EOF'`）安全 —— body 是
 * 字面文本。unquoted-delimiter heredoc（`<<EOF`）的 body 会做完整参数/命令/
 * 算术展开。
 *
 * SECURITY：tree-sitter-bash 有语法 gap —— unquoted heredoc body 中的反引号
 * 不会被解析为 command_substitution（body.children 为空，反引号在 body.text
 * 中）。但 bash 会执行它们。无法安全放宽 quoted-delimiter 要求 → 全部
 * unquoted heredoc 拒绝。
 */
function walkHeredocRedirect(node: BashNode): ParseForSecurityResult | null {
	let startText: string | null = null;
	let body: BashNode | null = null;

	for (const child of node.children) {
		if (child.node_type === "heredoc_start") {
			startText = child.text;
		} else if (child.node_type === "heredoc_body") {
			body = child;
		} else if (
			child.node_type === "<<" ||
			child.node_type === "<<-" ||
			child.node_type === "heredoc_end" ||
			child.node_type === "file_descriptor"
		) {
			// 预期的结构 token，安全跳过
			continue;
		} else {
			// SECURITY：tree-sitter 把同一行的 pipeline / command / file_redirect
			// 等放在 heredoc_redirect 子节点中（`ls <<'EOF' | rm x`），以前会被
			// 静默跳过，隐藏了管道命令。fail-closed。
			return tooComplexNode(child);
		}
	}

	const isQuoted =
		startText !== null &&
		((startText.startsWith("'") && startText.endsWith("'")) ||
			(startText.startsWith('"') && startText.endsWith('"')) ||
			startText.startsWith("\\"));

	if (!isQuoted) {
		return tooComplex(
			"Heredoc with unquoted delimiter undergoes shell expansion",
			"heredoc_redirect",
		);
	}

	if (body) {
		for (const child of body.children) {
			if (child.node_type !== "heredoc_content") {
				return tooComplexNode(child);
			}
		}
	}
	return null;
}

/**
 * Here-string redirect（`<<< content`）。content 成为 stdin，不是 argv / 路径。
 * 当 content 是字面 word / raw_string / 无 expansion 的 string 时安全。
 */
function walkHerestringRedirect(
	node: BashNode,
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	for (const child of node.children) {
		if (child.node_type === "<<<") continue;
		// 内容节点：复用 walkArgument。成功返回 string（丢弃），失败返回 needs-approval
		const content = walkArgument(child, innerCommands, varScope);
		if (typeof content !== "string") return content;
		// 内容虽不入 argv/envVars/redirects，但仍在 .text 中。检查 NEWLINE_HASH
		// 让下游 stripSafeWrappers 不被 `\n#` 注释截断。
		if (NEWLINE_HASH_RE.test(content)) return tooComplexNode(child);
	}
	return null;
}

// ───────────────────────────── test_command walker ─────────────────────────────

/**
 * `[[ EXPR ]]` 或 `[ EXPR ]` —— 条件测试。基于文件测试（-f, -d）、字符串比较
 * 等返回 true/false。无代码执行（内部若有 command_substitution 会被
 * walkArgument 拒绝）。作为合成 command push，argv[0]='[[' 让权限规则可匹配。
 */
function walkTestCommand(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const argv: string[] = ["[["];
	for (const child of node.children) {
		if (child.node_type === "[[" || child.node_type === "]]") continue;
		if (child.node_type === "[" || child.node_type === "]") continue;
		const err = walkTestExpr(child, argv, commands, varScope);
		if (err) return err;
	}
	const simple: SimpleCommand = { argv, envVars: [], redirects: [] };
	const semErr = checkSemantics(simple);
	if (semErr) return semErr;
	commands.push(simple);
	return null;
}

/** 递归遍历 test_command 表达式树（unary/binary/negated/parenthesized）。 */
function walkTestExpr(
	node: BashNode,
	argv: string[],
	innerCommands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	switch (node.node_type) {
		case "unary_expression":
		case "binary_expression":
		case "negated_expression":
		case "parenthesized_expression": {
			for (const c of node.children) {
				const err = walkTestExpr(c, argv, innerCommands, varScope);
				if (err) return err;
			}
			return null;
		}
		case "test_operator":
		case "!":
		case "(":
		case ")":
		case "&&":
		case "||":
		case "==":
		case "=":
		case "!=":
		case "<":
		case ">":
		case "=~":
			argv.push(node.text);
			return null;
		case "regex":
		case "extglob_pattern":
			// `=~` 或 `==`/`!=` 的 RHS。仅 pattern 文本，无代码执行。
			argv.push(node.text);
			return null;
		default: {
			// 操作数 —— word/string/number 等，由 walkArgument 校验
			const arg = walkArgument(node, innerCommands, varScope);
			if (typeof arg !== "string") return arg;
			argv.push(arg);
			return null;
		}
	}
}

// ───────────────────────────── for / if / while walkers ─────────────────────────────

/**
 * `for VAR in WORD...; do BODY; done` —— 对每个 WORD 执行一次 BODY。
 *
 * SECURITY：循环变量永远是 unknown-value（VAR_PLACEHOLDER）。即使迭代 word
 * 看起来是静态的，也可能是绝对路径 / glob / flag smuggling。`for i in /etc/*;
 * do rm $i; done` 的 body argv 必须看到 placeholder，路径校验看不到 /etc/*。
 */
function walkForStatement(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	let loopVar: string | null = null;
	let doGroup: BashNode | null = null;

	for (const child of node.children) {
		if (child.node_type === "variable_name") {
			loopVar = child.text;
		} else if (child.node_type === "do_group") {
			doGroup = child;
		} else if (
			child.node_type === "for" ||
			child.node_type === "in" ||
			child.node_type === "select" ||
			child.node_type === ";"
		) {
			continue;
		} else if (child.node_type === "command_substitution") {
			// `for i in $(seq 1 3)` —— inner cmd 被提取做权限检查
			const err = collectCommandSubstitution(child, commands, varScope);
			if (err) return err;
		} else {
			// 迭代值：由 walkArgument 校验，值丢弃（body argv 用 VAR_PLACEHOLDER）
			const arg = walkArgument(child, commands, varScope);
			if (typeof arg !== "string") return arg;
		}
	}

	if (!loopVar || !doGroup) return tooComplexNode(node);

	// SECURITY：`for PS4 in '$(id)'; do set -x; :; done` 直接通过 varScope.set
	// 设置 PS4，绕过 walkVariableAssignment 的 PS4/IFS 检查 → trace-time RCE。
	if (loopVar === "PS4" || loopVar === "IFS") {
		return tooComplex(
			`${loopVar} as loop variable bypasses assignment validation`,
			"for_statement",
		);
	}

	// 循环变量在真实 scope 中设置（bash 语义：循环后仍可见），但 body 用副本
	// （body 内赋值不外泄）。永远是 VAR_PLACEHOLDER。
	varScope.set(loopVar, VAR_PLACEHOLDER);
	const bodyScope = new Map(varScope);
	for (const c of doGroup.children) {
		if (c.node_type === "do" || c.node_type === "done" || c.node_type === ";") continue;
		const err = collectCommands(c, commands, bodyScope);
		if (err) return err;
	}
	return null;
}

/**
 * `if` / `while` / `until` 语句。
 *
 * SECURITY：分支 body 用 scope 副本 —— 条件分支内的赋值可能不执行，不能
 * 外泄到 fi/done 之后。`if false; then T=safe; fi && rm $T` 必须 reject $T。
 * 条件命令用真实 varScope（总是执行，赋值是无条件的，如 `while read V`）。
 */
function walkIfOrWhile(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	let seenThen = false;

	for (const child of node.children) {
		if (
			child.node_type === "if" ||
			child.node_type === "fi" ||
			child.node_type === "else" ||
			child.node_type === "elif" ||
			child.node_type === "while" ||
			child.node_type === "until" ||
			child.node_type === ";"
		) {
			continue;
		}
		if (child.node_type === "then") {
			seenThen = true;
			continue;
		}
		if (child.node_type === "do_group") {
			// while body：用 scope 副本（body 赋值不外泄到 done 之后）
			const bodyScope = new Map(varScope);
			for (const c of child.children) {
				if (c.node_type === "do" || c.node_type === "done" || c.node_type === ";") continue;
				const err = collectCommands(c, commands, bodyScope);
				if (err) return err;
			}
			continue;
		}
		if (child.node_type === "elif_clause" || child.node_type === "else_clause") {
			// elif/else 分支：用 scope 副本（赋值不外泄到 fi 之后）
			const branchScope = new Map(varScope);
			for (const c of child.children) {
				if (
					c.node_type === "elif" ||
					c.node_type === "else" ||
					c.node_type === "then" ||
					c.node_type === ";"
				) {
					continue;
				}
				const err = collectCommands(c, commands, branchScope);
				if (err) return err;
			}
			continue;
		}
		// 条件（seenThen=false）或 then-body（seenThen=true）
		const targetScope = seenThen ? new Map(varScope) : varScope;
		const before = commands.length;
		const err = collectCommands(child, commands, targetScope);
		if (err) return err;
		// `while read VAR` 中的 read VAR 在条件里 —— 在真实 scope 跟踪 VAR
		// 让 body 副本继承。值未知（stdin 输入）→ VAR_PLACEHOLDER。
		if (!seenThen) {
			for (let i = before; i < commands.length; i++) {
				const c = commands[i];
				if (c?.argv[0] === "read") {
					for (const a of c.argv.slice(1)) {
						if (!a.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
							const existing = varScope.get(a);
							if (
								existing !== undefined &&
								!containsAnyPlaceholder(existing)
							) {
								return tooComplex(
									`'read ${a}' in condition may not execute (||/pipeline/subshell); cannot prove it overwrites tracked literal '${existing}'`,
									"if_statement",
								);
							}
							varScope.set(a, VAR_PLACEHOLDER);
						}
					}
				}
			}
		}
	}
	return null;
}

// ───────────────────────────── unset_command walker ─────────────────────────────

/**
 * `unset FOO BAR` / `unset -f func`。安全：仅移除当前 shell 的变量/函数，
 * 无代码执行、无文件 I/O。
 *
 * SECURITY：从 varScope 同步删除，让后续 `$VAR` 引用正确 reject。
 * `VAR=safe && unset VAR && rm $VAR` 绝不能解析 $VAR。
 */
function walkUnsetCommand(
	node: BashNode,
	commands: SimpleCommand[],
	varScope: Map<string, string>,
): ParseForSecurityResult | null {
	const argv: string[] = [];

	for (const child of node.children) {
		switch (child.node_type) {
			case "unset":
				argv.push(child.text);
				break;
			case "variable_name":
				argv.push(child.text);
				varScope.delete(child.text);
				break;
			case "word": {
				const arg = walkArgument(child, commands, varScope);
				if (typeof arg !== "string") return arg;
				argv.push(arg);
				break;
			}
			default:
				return tooComplexNode(child);
		}
	}

	const simple: SimpleCommand = { argv, envVars: [], redirects: [] };
	const semErr = checkSemantics(simple);
	if (semErr) return semErr;
	commands.push(simple);
	return null;
}

// ───────────────────────────── post-argv 语义检查 ─────────────────────────────

/**
 * 对提取出的 SimpleCommand 做后置语义检查。
 *
 * 检测 argv[0] 命中 EVAL_LIKE_BUILTINS / ZSH_DANGEROUS_BUILTINS 的情况。
 * 这些 builtin 把参数当代码执行，单看 argv 无法判断危险性 → needs-approval。
 */
function checkSemantics(cmd: SimpleCommand): ParseForSecurityResult | null {
	if (cmd.argv.length === 0) return null;
	const name = cmd.argv[0];
	if (!name) return null;

	if (EVAL_LIKE_BUILTINS.has(name)) {
		return tooComplex(
			`Command uses eval-like builtin: ${name}`,
			"eval_like_builtin",
		);
	}
	if (ZSH_DANGEROUS_BUILTINS.has(name)) {
		return tooComplex(
			`Command uses zsh dangerous builtin: ${name}`,
			"zsh_dangerous_builtin",
		);
	}
	return null;
}

// ───────────────────────────── 工具函数 ─────────────────────────────

/**
 * 屏蔽 single/double-quoted 上下文中的 `{` 字符。
 *
 * 花括号展开在引号内不可能发生，所以引号内的 `{` 不会启动 obfuscation
 * 模式。用 bash-aware 单遍扫描器替代正则（避免 `'...'{...}` 的误判）。
 */
function maskBracesInQuotedContexts(cmd: string): string {
	// 快速路径：无 `{` → 无需扫描
	if (!cmd.includes("{")) return cmd;
	const out: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i]!;
		if (inSingle) {
			if (c === "'") inSingle = false;
			out.push(c === "{" ? " " : c);
			i++;
		} else if (inDouble) {
			if (c === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) {
				out.push(c, cmd[i + 1]!);
				i += 2;
			} else {
				if (c === '"') inDouble = false;
				out.push(c === "{" ? " " : c);
				i++;
			}
		} else {
			if (c === "\\" && i + 1 < cmd.length) {
				out.push(c, cmd[i + 1]!);
				i += 2;
			} else {
				if (c === "'") inSingle = true;
				else if (c === '"') inDouble = true;
				out.push(c);
				i++;
			}
		}
	}
	return out.join("");
}

/** 剥单引号：`'foo'` → `foo`。 */
function stripRawString(text: string): string {
	return text.slice(1, -1);
}

/** 构造 needs-approval 结果。 */
function tooComplex(reason: string, nodeType?: string): ParseForSecurityResult {
	return {
		verdict: "needs-approval",
		reason,
		commands: [],
		aborted: false,
		nodeType,
	};
}

/** 基于节点类型构造 needs-approval 结果。 */
function tooComplexNode(node: BashNode): ParseForSecurityResult {
	const reason =
		node.node_type === "ERROR"
			? "Parse error"
			: DANGEROUS_TYPES.has(node.node_type)
				? `Contains ${node.node_type}`
				: `Unhandled node type: ${node.node_type}`;
	return tooComplex(reason, node.node_type);
}
