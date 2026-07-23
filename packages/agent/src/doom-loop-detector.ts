/**
 * 通用跨工具/跨 turn 循环调用检测器。
 *
 * 跟踪最近 N 个 (toolName, argsSignature) 调用组成的滑动窗口，
 * 当窗口末尾出现连续 K 个完全相同签名的调用时触发告警，并在触发后自动清空窗口，
 * 避免对同一循环重复告警。
 *
 * 与 hashline/noop-loop-guard 的区别：后者只针对单文件 byte-identical no-op 编辑；
 * 本模块对任意工具调用做通用检测，覆盖所有 toolName，不区分具体语义。
 *
 * 设计目标：零外部依赖（不 import omp logger），纯 TypeScript，便于单测。
 */

import { createHash } from "node:crypto";

/** 滑动窗口中单条工具调用记录。 */
export interface ToolCallRecord {
	toolName: string;
	signature: string;
	timestamp: number;
}

/**
 * 工具护栏配置（参考 hermes 的 tool_guardrails）。
 *
 * warnings_enabled 控制是否输出 warn 级别决策；hard_stop_enabled 控制是否
 * 输出 block/halt 级别决策（默认关闭，交互式会话默认只做温和提示）。
 * warn_after 阈值在到达时返回 warn 决策；block_after / halt_after 阈值
 * 在到达时返回 block / halt 决策（仅当 hard_stop_enabled=true 时生效）。
 */
export interface ToolGuardrailConfig {
	/** 是否启用 warn 级别决策，默认 true */
	warnings_enabled: boolean;
	/** 是否启用 block/halt 级别决策，默认 false */
	hard_stop_enabled: boolean;
	/** 相同签名失败重复 warn 阈值，默认 2 */
	exact_failure_warn_after: number;
	/** 相同签名失败重复 block 阈值，默认 5 */
	exact_failure_block_after: number;
	/** 同工具不同参数失败重复 warn 阈值，默认 3 */
	same_tool_failure_warn_after: number;
	/** 同工具不同参数失败重复 halt 阈值，默认 8 */
	same_tool_failure_halt_after: number;
	/** 幂等工具返回相同结果 warn 阈值，默认 2 */
	no_progress_warn_after: number;
	/** 幂等工具返回相同结果 block 阈值，默认 5 */
	no_progress_block_after: number;
}

/** 工具护栏默认配置。 */
export const DEFAULT_TOOL_GUARDRAIL_CONFIG: ToolGuardrailConfig = {
	warnings_enabled: true,
	hard_stop_enabled: false,
	exact_failure_warn_after: 2,
	exact_failure_block_after: 5,
	same_tool_failure_warn_after: 3,
	same_tool_failure_halt_after: 8,
	no_progress_warn_after: 2,
	no_progress_block_after: 5,
};

/**
 * 幂等工具集合：只读、无副作用，重复调用可安全重放。
 * 参考 hermes 的 IDEMPOTENT_TOOL_NAMES，但使用 nexus 的工具名。
 */
export const IDEMPOTENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"ast_grep",
	"web_search",
	"web_fetch",
	"browser_snapshot",
	"lsp",
]);

/**
 * 副作用工具集合：会修改文件系统或外部状态，重复调用可能造成累积副作用。
 * 参考 hermes 的 MUTATING_TOOL_NAMES，但使用 nexus 的工具名。
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"bash",
	"write",
	"edit",
	"ast_edit",
	"todo",
	"memory",
	"skill_manage",
	"browser_click",
	"browser_type",
	"browser_navigate",
	"task",
]);

/** 检测器配置。 */
export interface DoomLoopConfig {
	/** 滑动窗口大小（跟踪最近 N 个调用），默认 10 */
	windowSize: number;
	/** 触发阈值（连续 K 个相同签名触发），默认 3 */
	threshold: number;
	/** 是否启用，默认 true */
	enabled: boolean;
	/**
	 * 工具护栏配置（可选）。启用后 beforeCall/afterCall 会按失败/无进展
	 * 阈值返回 allow | warn | block | halt 决策。未提供时使用默认配置。
	 */
	guardrails?: ToolGuardrailConfig;
}

/** 默认配置。 */
export const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
	windowSize: 10,
	threshold: 3,
	enabled: true,
};

/** 触发循环时返回的告警对象。 */
export interface DoomLoopAlert {
	/** 触发的工具名 */
	toolName: string;
	/** 触发时的连续次数（>= threshold） */
	consecutiveCount: number;
	/** 触发循环的签名（用于调试） */
	signature: string;
	/** 注入给模型的提示消息 */
	message: string;
}

/**
 * 工具调用签名：toolName + argsHash 的稳定不可逆标识。
 *
 * argsHash 为 normalizeArgs(args) 的 sha256 十六进制摘要，
 * 用于在 Map 中作为 key 而不泄露原始参数值。
 */
export class ToolCallSignature {
	readonly toolName: string;
	readonly argsHash: string;

	constructor(toolName: string, argsHash: string) {
		this.toolName = toolName;
		this.argsHash = argsHash;
	}

	/**
	 * 从工具名与原始参数构造签名。
	 * args 通过 normalizeArgs 归一化后取 sha256，保证 key 顺序无关。
	 */
	static fromCall(toolName: string, args: unknown): ToolCallSignature {
		const canonical = normalizeArgs(args);
		const argsHash = createHash("sha256").update(canonical, "utf8").digest("hex");
		return new ToolCallSignature(toolName, argsHash);
	}

	/** 返回可用作 Map key 的复合字符串。 */
	get key(): string {
		return `${this.toolName}::${this.argsHash}`;
	}

	/** 返回不含原始参数值的公共元数据。 */
	toMetadata(): { tool_name: string; args_hash: string } {
		return { tool_name: this.toolName, args_hash: this.argsHash };
	}
}

/**
 * 工具护栏决策。由 beforeCall / afterCall 返回，调用方据此决定
 * 是否放行、告警、阻断或硬停。
 */
export interface GuardrailDecision {
	/** 决策动作：allow（放行）| warn（告警但放行）| block（阻断执行）| halt（硬停当前路径） */
	action: "allow" | "warn" | "block" | "halt";
	/** 机器可读决策码，如 repeated_exact_failure_warning */
	code: string;
	/** 面向模型的提示消息 */
	message: string;
	/** 触发决策的工具名 */
	toolName: string;
	/** 触发时的计数（连续失败次数 / 重复结果次数） */
	count: number;
	/** 触发决策的签名（可选，用于调试） */
	signature?: ToolCallSignature;
}

/**
 * 归一化工具调用参数，生成稳定签名。
 *
 * 递归排序对象的所有 key（包括嵌套对象），使 `{a:1,b:2}` 与 `{b:2,a:1}`
 * 产生相同签名。数组保持元素顺序，但元素本身递归归一化。
 * undefined / function / symbol 一律视为 undefined，避免签名漂移。
 * 含循环引用时输出固定占位符，不抛错。
 */
export function normalizeArgs(args: unknown): string {
	return stableStringify(args, new WeakSet<object>());
}

/**
 * 递归构造稳定 JSON 字符串。
 *
 * 不直接用 `JSON.stringify(args, Object.keys(args).sort())` 是因为该写法
 * 只排序根对象 key，嵌套对象仍按原始插入顺序输出，签名不稳定。
 * 这里手工遍历，对每一层对象的 key 都做 sort，再拼接成合法 JSON。
 */
function stableStringify(value: unknown, seen: WeakSet<object>): string {
	// undefined / function / symbol → 统一视为 undefined
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return "undefined";
	}
	if (value === null) return "null";
	if (typeof value === "bigint") {
		// JSON.stringify 对 bigint 会抛错，转成带类型标签的字符串
		return `"bigint:${value.toString()}"`;
	}
	if (typeof value !== "object") {
		// number / string / boolean：直接用 JSON.stringify 处理基本类型
		return JSON.stringify(value);
	}
	// 到这里 typeof === "object"
	const obj = value as object;
	if (seen.has(obj)) return '"[Circular]"';
	seen.add(obj);

	if (Array.isArray(value)) {
		// 数组保持元素顺序，但每个元素递归归一化
		const items = value.map(item => stableStringify(item, seen));
		return `[${items.join(",")}]`;
	}
	// 普通对象：递归排序所有 key
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const pairs = keys.map(k => `${JSON.stringify(k)}:${stableStringify(record[k], seen)}`);
	return `{${pairs.join(",")}}`;
}

/**
 * 从工具结果对象中提取文本内容（取首个 text 块），用于失败分类。
 * 无法提取时返回空字符串。
 */
function extractResultText(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);
	const obj = result as Record<string, unknown>;
	// 兼容 AgentToolResult 的 content 数组结构
	const content = obj.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block !== null && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") return b.text;
			}
		}
	}
	// 兼容直接含 text 字段的结构
	if (typeof obj.text === "string") return obj.text;
	return "";
}

/**
 * 工具失败分类器（调用方未显式传 isError 时的安全回退）。
 *
 * bash 工具看 details.exitCode != 0；其他工具看结果文本是否含 error 字段。
 * 参考 hermes 的 classify_tool_failure，但适配 nexus 的结果结构。
 *
 * @param toolName 工具名
 * @param result 工具执行结果（AgentToolResult 或字符串）
 * @returns 是否判定为失败
 */
export function classifyToolFailure(toolName: string, result: unknown): boolean {
	if (result === null || result === undefined) return false;

	// 先看结构化 details（AgentToolResult.details）
	if (typeof result === "object") {
		const obj = result as Record<string, unknown>;
		// AgentToolResult.isError 已经是权威标记
		if (obj.isError === true) return true;

		const details = obj.details;
		if (details !== null && typeof details === "object") {
			const d = details as Record<string, unknown>;
			// bash 看 exit code
			if (toolName === "bash") {
				const exitCode = d.exitCode;
				if (typeof exitCode === "number" && exitCode !== 0) return true;
			}
			// 通用：details 含 error 字段
			if (typeof d.error === "string" && d.error.length > 0) return true;
		}
	}

	// 回退到文本内容启发式
	const text = extractResultText(result);
	if (text.length === 0) return false;
	const lower = text.slice(0, 500).toLowerCase();
	if (lower.includes('"error"') || lower.includes('"failed"') || text.startsWith("Error")) {
		return true;
	}
	return false;
}

/**
 * 对幂等工具的结果取哈希，用于 no_progress 检测。
 * 相同结果返回相同哈希，提示模型正在重复无进展的只读调用。
 */
function resultHash(result: unknown): string {
	const text = extractResultText(result);
	if (text.length === 0) return "empty";
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 通用循环检测器。无外部依赖，线程不安全（单 agent loop 串行使用即可）。
 *
 * 同时支持两种检测模式（向后兼容）：
 * 1. 旧模式：recordCall + detect —— 滑动窗口连续相同签名告警。
 * 2. 新模式：beforeCall + afterCall —— 工具护栏，区分成功/失败、幂等/副作用，
 *    返回 allow | warn | block | halt 决策。
 */
export class DoomLoopDetector {
	private readonly config: DoomLoopConfig;
	private window: ToolCallRecord[] = [];

	// —— 工具护栏状态（beforeCall / afterCall 使用）——
	private readonly guardrailConfig: ToolGuardrailConfig;
	/** 相同签名失败计数（按 ToolCallSignature.key 索引） */
	private readonly exactFailureCounts: Map<string, number> = new Map();
	/** 同工具失败计数（按 toolName 索引，不区分参数） */
	private readonly sameToolFailureCounts: Map<string, number> = new Map();
	/** 幂等工具无进展记录：signature.key → [resultHash, repeatCount] */
	private readonly noProgress: Map<string, [string, number]> = new Map();

	constructor(config?: Partial<DoomLoopConfig>) {
		this.config = { ...DEFAULT_DOOM_LOOP_CONFIG, ...config };
		this.guardrailConfig = config?.guardrails ?? DEFAULT_TOOL_GUARDRAIL_CONFIG;
	}

	/** 记录一次工具调用。enabled=false 时为 no-op。 */
	recordCall(toolName: string, args: Record<string, unknown>): void {
		if (!this.config.enabled) return;
		const signature = normalizeArgs(args);
		this.window.push({ toolName, signature, timestamp: Date.now() });
		// 超过窗口大小则从队首出队。windowSize 默认 10，shift 成本可忽略。
		while (this.window.length > this.config.windowSize) {
			this.window.shift();
		}
	}

	/**
	 * 检测是否陷入循环。从窗口末尾向前扫描，统计连续相同
	 * (toolName, signature) 的数量；达到 threshold 时返回告警并自动 reset。
	 * enabled=false 或窗口为空时返回 null。
	 */
	detect(): DoomLoopAlert | null {
		if (!this.config.enabled) return null;
		if (this.window.length === 0) return null;

		const last = this.window[this.window.length - 1];
		let consecutiveCount = 0;
		for (let i = this.window.length - 1; i >= 0; i--) {
			const record = this.window[i];
			if (record.toolName === last.toolName && record.signature === last.signature) {
				consecutiveCount++;
			} else {
				break;
			}
		}

		if (consecutiveCount < this.config.threshold) return null;

		const alert: DoomLoopAlert = {
			toolName: last.toolName,
			consecutiveCount,
			signature: last.signature,
			message: `检测到循环：连续 ${consecutiveCount} 次调用 ${last.toolName} 相同参数，请改变策略或停止重复操作`,
		};
		// 触发后自动 reset，避免对同一循环重复告警
		this.window = [];
		return alert;
	}

	/**
	 * 工具执行前的护栏检查（参考 hermes ToolCallGuardrailController.before_call）。
	 *
	 * 同时完成两件事：
	 * 1. 记录到滑动窗口（等价于 recordCall，保持旧 detect() 可用）。
	 * 2. 根据历史失败/无进展计数返回决策：
	 *    - exact_failure 计数 >= block_after → block（阻断相同签名重复失败）
	 *    - 幂等工具 no_progress 计数 >= block_after → block（阻断无进展只读调用）
	 *    - 否则 → allow
	 *
	 * @param toolName 工具名
	 * @param args 原始参数（将被归一化取哈希）
	 * @returns GuardrailDecision，调用方据此决定是否放行/告警/阻断
	 */
	beforeCall(toolName: string, args: unknown): GuardrailDecision {
		const signature = ToolCallSignature.fromCall(toolName, args);

		// 同步记录到滑动窗口，保持旧 detect() 行为不变
		if (this.config.enabled) {
			this.window.push({ toolName, signature: signature.argsHash, timestamp: Date.now() });
			while (this.window.length > this.config.windowSize) {
				this.window.shift();
			}
		}

		// hard_stop 未启用时不产生 block 决策
		if (!this.guardrailConfig.hard_stop_enabled) {
			return { action: "allow", code: "allow", message: "", toolName, count: 0, signature };
		}

		// 相同签名失败重复 → block
		const exactCount = this.exactFailureCounts.get(signature.key) ?? 0;
		if (exactCount >= this.guardrailConfig.exact_failure_block_after) {
			return {
				action: "block",
				code: "repeated_exact_failure_block",
				message: `阻断 ${toolName}：相同调用已失败 ${exactCount} 次。请停止以相同参数重试，改变策略或说明阻塞原因。`,
				toolName,
				count: exactCount,
				signature,
			};
		}

		// 幂等工具无进展 → block
		if (this.isIdempotent(toolName)) {
			const record = this.noProgress.get(signature.key);
			if (record !== undefined) {
				const repeatCount = record[1];
				if (repeatCount >= this.guardrailConfig.no_progress_block_after) {
					return {
						action: "block",
						code: "idempotent_no_progress_block",
						message: `阻断 ${toolName}：此只读调用已连续 ${repeatCount} 次返回相同结果。请使用已有结果或改用不同查询。`,
						toolName,
						count: repeatCount,
						signature,
					};
				}
			}
		}

		return { action: "allow", code: "allow", message: "", toolName, count: 0, signature };
	}

	/**
	 * 工具执行后的护栏记录（参考 hermes ToolCallGuardrailController.after_call）。
	 *
	 * 根据执行结果更新内部计数并返回决策：
	 * - 失败时：累加 exact_failure / same_tool_failure 计数；
	 *   same_tool_failure 达 halt_after → halt；exact_failure 达 warn_after → warn；
	 *   same_tool_failure 达 warn_after → warn。
	 * - 成功时：清零失败计数；幂等工具若返回相同结果则累加 no_progress，
	 *   达 warn_after → warn。
	 *
	 * 注意：afterCall 在工具已执行后调用，halt 决策仅作告警信号；
	 * 累积的计数会在下一次 beforeCall 触发 block。
	 *
	 * @param toolName 工具名
	 * @param args 原始参数
	 * @param result 工具执行结果
	 * @param isError 是否失败（未提供时用 classifyToolFailure 回退判定）
	 * @returns GuardrailDecision
	 */
	afterCall(
		toolName: string,
		args: unknown,
		result: unknown,
		isError?: boolean,
	): GuardrailDecision {
		const signature = ToolCallSignature.fromCall(toolName, args);
		const failed = isError ?? classifyToolFailure(toolName, result);

		if (failed) {
			const exactCount = (this.exactFailureCounts.get(signature.key) ?? 0) + 1;
			this.exactFailureCounts.set(signature.key, exactCount);
			// 失败时清除无进展记录（失败不算"相同结果"）
			this.noProgress.delete(signature.key);

			const sameCount = (this.sameToolFailureCounts.get(toolName) ?? 0) + 1;
			this.sameToolFailureCounts.set(toolName, sameCount);

			// 同工具失败达 halt 阈值 → halt（hard_stop 启用时）
			if (
				this.guardrailConfig.hard_stop_enabled &&
				sameCount >= this.guardrailConfig.same_tool_failure_halt_after
			) {
				return {
					action: "halt",
					code: "same_tool_failure_halt",
					message: `硬停 ${toolName}：本轮已失败 ${sameCount} 次。请停止重试同一失败路径，改用其他方法。`,
					toolName,
					count: sameCount,
					signature,
				};
			}

			// 相同签名失败达 warn 阈值 → warn
			if (
				this.guardrailConfig.warnings_enabled &&
				exactCount >= this.guardrailConfig.exact_failure_warn_after
			) {
				return {
					action: "warn",
					code: "repeated_exact_failure_warning",
					message: `${toolName} 已以相同参数失败 ${exactCount} 次，疑似循环。请检查错误并改变策略，而非原样重试。`,
					toolName,
					count: exactCount,
					signature,
				};
			}

			// 同工具失败达 warn 阈值 → warn
			if (
				this.guardrailConfig.warnings_enabled &&
				sameCount >= this.guardrailConfig.same_tool_failure_warn_after
			) {
				return {
					action: "warn",
					code: "same_tool_failure_warning",
					message: `${toolName} 本轮已失败 ${sameCount} 次，疑似循环。请先诊断最新错误、验证假设，再尝试不同参数或换用其他工具。`,
					toolName,
					count: sameCount,
					signature,
				};
			}

			return { action: "allow", code: "allow", message: "", toolName, count: exactCount, signature };
		}

		// 成功：清零失败计数
		this.exactFailureCounts.delete(signature.key);
		this.sameToolFailureCounts.delete(toolName);

		// 非幂等工具不检测无进展
		if (!this.isIdempotent(toolName)) {
			this.noProgress.delete(signature.key);
			return { action: "allow", code: "allow", message: "", toolName, count: 0, signature };
		}

		// 幂等工具：检测是否返回相同结果
		const hash = resultHash(result);
		const previous = this.noProgress.get(signature.key);
		let repeatCount = 1;
		if (previous !== undefined && previous[0] === hash) {
			repeatCount = previous[1] + 1;
		}
		this.noProgress.set(signature.key, [hash, repeatCount]);

		if (
			this.guardrailConfig.warnings_enabled &&
			repeatCount >= this.guardrailConfig.no_progress_warn_after
		) {
			return {
				action: "warn",
				code: "idempotent_no_progress_warning",
				message: `${toolName} 已连续 ${repeatCount} 次返回相同结果。请使用已有结果或改用不同查询，而非原样重复。`,
				toolName,
				count: repeatCount,
				signature,
			};
		}

		return { action: "allow", code: "allow", message: "", toolName, count: repeatCount, signature };
	}

	/**
	 * 判断工具是否幂等（只读、无副作用）。
	 * 显式列在 MUTATING_TOOL_NAMES 中的返回 false；列在 IDEMPOTENT_TOOL_NAMES 中的返回 true。
	 */
	private isIdempotent(toolName: string): boolean {
		if (MUTATING_TOOL_NAMES.has(toolName)) return false;
		return IDEMPOTENT_TOOL_NAMES.has(toolName);
	}

	/** 重置窗口与护栏状态（手动清除历史）。 */
	reset(): void {
		this.window = [];
		this.exactFailureCounts.clear();
		this.sameToolFailureCounts.clear();
		this.noProgress.clear();
	}

	/** 获取当前窗口状态（用于测试/调试）。返回的数组为只读视图。 */
	get state(): readonly ToolCallRecord[] {
		return this.window;
	}
}
