/**
 * Nexus Compaction 类型定义
 *
 * 与 omp `@oh-my-pi/agent` 的 AgentMessage / Message 结构兼容：
 * 通过结构化类型（structural typing）兼容，不强制依赖 omp 包，
 * 这样 nexus-compaction 可独立测试，也可作为 omp compaction 的可选替代策略。
 *
 * 角色对齐 Grok 的 `CompactionRole`（System/Developer/User/Assistant/Tool）
 * 与 omp 的 Message role（user/assistant/toolResult/system/...）。
 */

// ============================================================================
// 内容块（与 omp TextContent / ImageContent 结构兼容）
// ============================================================================

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64 编码或 URL，omp 兼容字段 */
	data?: string;
	url?: string;
	/** omp 字段，介质类型 */
	mediaType?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/** OpenAI Responses 加密 reasoning 签名 */
	thinkingSignature?: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultContent {
	type: "toolResult";
	id: string;
	content: (TextContent | ImageContent)[];
	isError?: boolean;
}

/** 内容块联合类型（兼容 omp 的 content block） */
export type ContentBlock =
	| TextContent
	| ImageContent
	| ThinkingContent
	| RedactedThinkingContent
	| ToolCallContent
	| ToolResultContent;

// ============================================================================
// 消息类型（结构兼容 omp Message / AgentMessage）
// ============================================================================

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	timestamp?: number;
}

export interface UserMessage {
	role: "user";
	content: string | ContentBlock[];
	timestamp?: number;
	attribution?: string;
}

export interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
	errorStatus?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};
}

export interface ToolResultMessage {
	role: "toolResult";
	content: string | (TextContent | ImageContent)[];
	timestamp?: number;
	/** 关联的 toolCall id */
	toolCallId?: string;
}

/** omp hookMessage / 自定义消息的通用形态 */
export interface HookMessage {
	role: "hookMessage";
	content: string | (TextContent | ImageContent)[];
	timestamp?: number;
}

/** omp branchSummary 消息 */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	timestamp?: number;
}

/** omp compactionSummary 消息 */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	timestamp?: number;
	blocks?: ContentBlock[];
}

/** omp bashExecution 消息（作为 user-role turn 边界） */
export interface BashExecutionMessage {
	role: "bashExecution";
	command?: string;
	output?: string;
	timestamp?: number;
}

/**
 * Nexus 消息联合类型，结构兼容 omp AgentMessage。
 *
 * 凡是带 `role` 字段的对象都可被 nexus-compaction 处理；
 * 不识别的 role 会按 'user' 兜底处理（提取 text）。
 */
export type NexusMessage =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| HookMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage
	| BashExecutionMessage
	| { role: string; content?: unknown; timestamp?: number };

// ============================================================================
// Grok CompactionRole 对齐
// ============================================================================

/**
 * Grok 的 harness-agnostic 角色。
 * 见 grok-build-main/crates/common/xai-grok-compaction/src/item.rs
 */
export type CompactionRole = "system" | "developer" | "user" | "assistant" | "tool";

// ============================================================================
// 配置
// ============================================================================

/**
 * Compaction 策略选择
 * - `omp`：完全使用 omp 原生 compaction（调用方传入）
 * - `nexus`：完全使用 nexus 四级 compaction
 * - `hybrid`：先走 nexus code/intra（局部压缩），再走 omp 默认（全局摘要）
 */
export type CompactionStrategy = "omp" | "nexus" | "hybrid";

/**
 * nexus 四级 compaction 配置
 */
export interface NexusCompactionConfig {
	/** 策略 */
	strategy: CompactionStrategy;
	/** 跨 turn 重复内容压缩阈值（字节），超过则用引用替代 */
	interThreshold: number;
	/** 单 turn 内重复 block 合并阈值（字节） */
	intraThreshold: number;
	/** 代码块压缩触发阈值（行数），超过则保留签名 + 占位 */
	codeBlockSize: number;
	/** 历史摘要触发的 turn 数阈值，超过则用 LLM 摘要替代 */
	historyTurns: number;
	/** 用户消息截断字符数（对齐 Grok `user_message_truncate_chars`） */
	userMessageTruncateChars: number;
	/** 最小可压缩 token 数（对齐 Grok `min_compactable_tokens`） */
	minCompactableTokens: number;
	/** 最大压缩比（after/before），超过则拒绝应用 */
	maxReductionRatio: number;
	/** 历史摘要的最大保留最近 turn 数 */
	keepRecentTurns: number;
}

export const DEFAULT_NEXUS_CONFIG: NexusCompactionConfig = {
	strategy: "nexus",
	interThreshold: 512,
	intraThreshold: 256,
	codeBlockSize: 40,
	historyTurns: 20,
	userMessageTruncateChars: 3000,
	minCompactableTokens: 500,
	maxReductionRatio: 0.8,
	keepRecentTurns: 4,
};

// ============================================================================
// LLM Sampler 抽象接口（对齐 Grok `CompactionSampler`）
// ============================================================================

/**
 * LLM 采样器接口，用于 history compaction 调用 LLM 生成摘要。
 *
 * Windows 环境下无法实际跑 LLM，调用方可以注入 mock；
 * 算法逻辑完整，注入真实 sampler 后即可工作。
 */
export interface CompactionSampler {
	/**
	 * 对一组消息生成摘要。
	 * @param messages 待摘要的消息列表
	 * @param systemPrompt 系统提示
	 * @param userPrompt 用户提示（包含占位符）
	 * @returns 摘要文本
	 */
	sampleSummary(
		messages: NexusMessage[],
		systemPrompt: string,
		userPrompt: string,
		signal?: AbortSignal,
	): Promise<string>;
}

/**
 *omp 原生 compaction 函数签名（hybrid 模式下调用方注入）。
 *
 * 对齐 omp `compact(preparation, model, apiKey, ...)` 的纯函数形态：
 * 输入消息数组，输出（摘要 + 压缩后消息数组）。
 */
export type OmpCompactionFn = (
	messages: NexusMessage[],
	options?: {
		previousSummary?: string;
		signal?: AbortSignal;
		customInstructions?: string;
	},
) => Promise<{ summary: string; messages: NexusMessage[] }>;

// ============================================================================
// Compaction 结果
// ============================================================================

export interface CompactionResult {
	/** 压缩后消息列表 */
	messages: NexusMessage[];
	/** 压缩前 token 估算 */
	tokensBefore: number;
	/** 压缩后 token 估算 */
	tokensAfter: number;
	/** 被压缩的 turn 数 */
	turnsCompacted: number;
	/** 应用的策略 */
	strategy: CompactionStrategy;
	/** 每级是否触发的统计 */
	stages: {
		inter: boolean;
		intra: boolean;
		code: boolean;
		history: boolean;
	};
	/** 生成的摘要文本（若触发了 history compaction） */
	summary?: string;
}

// ============================================================================
// 辅助：从 NexusMessage 提取文本
// ============================================================================

/**
 * 从单条消息提取纯文本（用于 token 估算 / 重复检测）。
 * 不修改原消息。
 */
export function extractMessageText(message: NexusMessage): string {
	const role = (message as { role?: string }).role;
	if (role === "bashExecution") {
		const bash = message as BashExecutionMessage;
		return `${bash.command ?? ""}\n${bash.output ?? ""}`;
	}
	if (role === "branchSummary" || role === "compactionSummary") {
		return (message as BranchSummaryMessage).summary ?? "";
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; thinking?: string; data?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
		else if (b.type === "redactedThinking" && typeof b.data === "string") parts.push(b.data);
		else if (b.type === "toolCall") {
			const tc = block as ToolCallContent;
			parts.push(tc.name);
			try {
				parts.push(JSON.stringify(tc.arguments ?? {}));
			} catch {
				// 忽略循环引用
			}
		} else if (b.type === "toolResult") {
			const tr = block as ToolResultContent;
			for (const sub of tr.content ?? []) {
				if (sub.type === "text") parts.push(sub.text);
			}
		}
	}
	return parts.join("\n");
}

/**
 * 将 NexusMessage 映射到 Grok CompactionRole。
 * - system → system
 * - hookMessage / compactionSummary / branchSummary → developer（摘要载体）
 * - assistant → assistant
 * - toolResult → tool
 * - user / bashExecution / 其它 → user
 */
export function toCompactionRole(message: NexusMessage): CompactionRole {
	const role = (message as { role?: string }).role ?? "user";
	switch (role) {
		case "system":
			return "system";
		case "assistant":
			return "assistant";
		case "toolResult":
			return "tool";
		case "hookMessage":
		case "compactionSummary":
		case "branchSummary":
			return "developer";
		case "user":
		case "bashExecution":
		default:
			return "user";
	}
}

/**
 * 判断消息是否为 compaction summary（对齐 Grok `is_compaction_summary`）。
 */
export function isCompactionSummary(message: NexusMessage): boolean {
	const role = (message as { role?: string }).role;
	return role === "compactionSummary" || role === "branchSummary";
}

// ============================================================================
// Compaction Prompt 模板（对齐 Grok `format_compaction_developer_prompt` 等）
// ============================================================================

/**
 * Compaction prompt 对：system + user。
 * 用于 history / step / code-compaction 的 LLM 摘要调用。
 */
export interface CompactionPrompt {
	/** 系统提示（developer prompt 角色） */
	system: string;
	/** 用户提示（含占位符填充后的最终文本） */
	user: string;
}

// ============================================================================
// CompactionItem 抽象（对齐 Grok `CompactionItem` trait）
// ============================================================================

/**
 * Harness-agnostic 的 compaction item 契约。
 *
 * 对齐 Grok `xai-grok-compaction/src/item.rs::CompactionItem`。
 * 让 select / intra 算法可对任意 harness 的 turn/item 操作，
 * 不直接耦合 NexusMessage 形态。
 *
 * 实现者：
 * - 默认实现见 `NexusCompactionItemAdapter`（包装 NexusMessage）
 * - 调用方也可自定义实现以对接其它 harness
 */
export interface CompactionItem {
	/** 该 item 的 harness-agnostic 角色 */
	role(): CompactionRole;
	/** 文本内容（无则返回 null） */
	text(): string | null;
	/** 是否为 tool 结果（用于切分点安全约束） */
	isToolResult(): boolean;
	/** 是否携带 tool 请求（assistant 角色） */
	hasToolRequests(): boolean;
	/** 是否为 compaction summary 载体 */
	isCompactionSummary(): boolean;
}

/**
 * Token 计数函数：把单个 item 映射为 token 数。
 * 用于 `selectTurnsToCompact` 的预算计算。
 */
export type ItemTokenCounter<I> = (item: I) => number;
