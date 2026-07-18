/**
 * @nexus-agent/compaction —— 多级 compaction 引擎
 *
 * 移植自 Grok Build 的 `xai-grok-compaction`，提供四级 compaction 算法：
 * - **inter-compaction**：跨 turn 重复内容压缩（剥离 `<grok_user_queries>`、跨 turn 去重）
 * - **intra-compaction**：单 turn 内重复 block 合并、thinking 块折叠、相邻重复消息合并
 * - **code-compaction**：代码块专用压缩（保留签名 + 首/末注释，中间用占位符）
 * - **history-compaction**：长期历史摘要（LLM 采样 + 摘要清洗 + 重组）
 *
 * 三种调度策略：
 * - `omp`：完全委托给 omp 原生 compaction（调用方注入函数）
 * - `nexus`：依次执行 nexus 四级 compaction
 * - `hybrid`：先 nexus 局部压缩，再 omp 全局摘要
 *
 * 与 omp `@oh-my-pi/agent` 的 `AgentMessage` / `Message` 结构兼容：
 * 通过结构化类型（structural typing）兼容，不强制依赖 omp 包。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 类型与配置
// ─────────────────────────────────────────────────────────────────────────────

export type {
	// 内容块
	TextContent,
	ImageContent,
	ThinkingContent,
	RedactedThinkingContent,
	ToolCallContent,
	ToolResultContent,
	ContentBlock,
	// 消息类型
	SystemMessage,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	HookMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	BashExecutionMessage,
	NexusMessage,
	// Grok 角色对齐
	CompactionRole,
	// 策略与配置
	CompactionStrategy,
	NexusCompactionConfig,
	// LLM 采样器与 omp 注入
	CompactionSampler,
	OmpCompactionFn,
	// 结果
	CompactionResult,
	// Prompt 模板
	CompactionPrompt,
	// CompactionItem 抽象（对齐 Grok trait）
	CompactionItem,
	ItemTokenCounter,
} from "./types";

export {
	DEFAULT_NEXUS_CONFIG,
	extractMessageText,
	toCompactionRole,
	isCompactionSummary,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Token 估算
// ─────────────────────────────────────────────────────────────────────────────

export {
	estimateTextTokens,
	estimateMessageTokens,
	estimateMessagesTokens,
	IMAGE_TOKEN_ESTIMATE,
} from "./tokenizer";

// ─────────────────────────────────────────────────────────────────────────────
// 四级 compaction 算法
// ─────────────────────────────────────────────────────────────────────────────

// 1. inter-compaction（跨 turn）
export {
	interCompaction,
	filterTurnsForInterCompaction,
	separatePriorUserQueries,
	splitPriorCompactionText,
	extractUserQueriesFromTurns,
	truncateMiddle,
	assembleUserQueriesPreamble,
	deduplicateCrossTurnContent,
} from "./inter-compaction";
export type { InterCompactionStats } from "./inter-compaction";

// 2. intra-compaction（单 turn 内）
export {
	intraCompaction,
	mergeDuplicateBlocks,
	collapseThinkingBlocks,
	mergeAdjacentDuplicateMessages,
} from "./intra-compaction";
export type { IntraCompactionStats } from "./intra-compaction";

// 3. code-compaction（代码块专用）
export {
	codeCompaction,
	compactCodeBlock,
	compactCodeInText,
	compactCodeInMessage,
	extractCodeBlocks,
	isSignatureLine,
	isCommentLine,
} from "./code-compaction";
export type { CodeBlock, CodeCompactionStats } from "./code-compaction";

// 4. history-compaction（长期历史摘要）
export {
	historyCompaction,
	splitIntoTurns,
	formatCompactSummary,
	isDegenerateSummary,
	formatCompactSummaryContent,
	DEFAULT_COMPACTION_SYSTEM_PROMPT,
	DEFAULT_COMPACTION_USER_PROMPT,
} from "./history-compaction";
export type { HistoryCompactionStats } from "./history-compaction";

// ─────────────────────────────────────────────────────────────────────────────
// 尾部保留选择器（对齐 Grok `select_turns_to_compact`）
// ─────────────────────────────────────────────────────────────────────────────

export { selectTurnsToCompact } from "./select";
export type { SplitPlan } from "./select";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 模板（对齐 Grok prompt 文本）
// ─────────────────────────────────────────────────────────────────────────────

export {
	HISTORY_COMPACTION_PROMPT_BODY,
	STEP_COMPACTION_PROMPT_BODY,
	CODE_COMPACTION_SUMMARY_PROMPT_BODY,
	FULL_REPLACE_SUMMARY_PROMPT,
	buildHistoryCompactionPrompt,
	buildStepCompactionPrompt,
	buildCodeCompactionPrompt,
	buildFullReplaceSummaryPrompt,
} from "./prompts";

// ─────────────────────────────────────────────────────────────────────────────
// 策略调度器（主入口）
// ─────────────────────────────────────────────────────────────────────────────

export {
	compact,
	runNexusCompaction,
	runOmpCompaction,
	runHybridCompaction,
	resolveConfig,
} from "./strategy";
export type { CompactionDispatcherOptions } from "./strategy";
