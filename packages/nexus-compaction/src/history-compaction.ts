/**
 * 长期历史摘要（history-compaction）
 *
 * 移植自 Grok `xai-grok-compaction/src/intra_compaction/compact.rs::apply_history_compaction`
 * + `code_compaction/summary.rs::format_compact_summary`。
 *
 * 核心算法：
 * 1. 按用户消息切分 turn
 * 2. 若 turn 数超过 `historyTurns`，将早期 turn（除最近 `keepRecentTurns` 个）
 *    送入 LLM 生成摘要
 * 3. 摘要清洗（`format_compact_summary`）：剥离 `<analysis>` 草稿块，
 *    `<summary>` 标签转为 `Summary:` 标题，控制 token 中和
 * 4. 用摘要消息替代原始早期 turn，保留最近 turn 完整
 *
 * Windows 环境无 LLM：调用方注入 sampler；未注入时仅做结构化裁剪。
 */

import type { NexusMessage, NexusCompactionConfig, CompactionSampler } from "./types";
import { extractMessageText, toCompactionRole } from "./types";
import { estimateMessageTokens } from "./tokenizer";
import { assembleUserQueriesPreamble, extractUserQueriesFromTurns } from "./inter-compaction";

/** History-compaction 统计 */
export interface HistoryCompactionStats {
	applied: boolean;
	/** 被摘要替代的 turn 数 */
	turnsSummarized: number;
	/** 保留的最近 turn 数 */
	turnsKept: number;
	/** 压缩前 token 数 */
	tokensBefore: number;
	/** 压缩后 token 数 */
	tokensAfter: number;
}

// ============================================================================
// Turn 切分
// ============================================================================

/**
 * 按用户消息切分 turn：每遇到一个 user-role 消息开始新 turn。
 *
 * 对齐 omp `findValidCutPoints` 的语义：
 * - user / bashExecution → turn 边界
 * - assistant / toolResult → 当前 turn 内
 * - system → 跳过（不参与 turn 切分）
 * - compactionSummary / branchSummary → 独立 turn（摘要载体）
 */
export function splitIntoTurns(messages: NexusMessage[]): NexusMessage[][] {
	const turns: NexusMessage[][] = [];
	let current: NexusMessage[] | null = null;
	for (const msg of messages) {
		const role = toCompactionRole(msg);
		if (role === "system") {
			// system 消息单独成 turn（通常仅首条）
			turns.push([msg]);
			current = null;
			continue;
		}
		if (role === "user" || current === null) {
			// 新 turn
			current = [];
			turns.push(current);
		}
		current.push(msg);
	}
	return turns;
}

// ============================================================================
// 摘要清洗（对齐 Grok `format_compact_summary`）
// ============================================================================

/**
 * 清洗 LLM 摘要输出：
 * - 剥离前导 `<analysis>...</analysis>` 草稿块
 * - 将 `<summary>...</summary>` 转为 `Summary:\n{inner}` 标题
 * - 中和残留的控制 token（避免下轮被模型重新当作 live tag）
 * - 折叠 3+ 连续空行为 2 行
 *
 * 对齐 Grok `format_compact_summary`。
 */
export function formatCompactSummary(summary: string): string {
	let result = summary;

	// Step 1: 剥离前导 <analysis> 块
	while (true) {
		const start = result.indexOf("<analysis>");
		if (start === -1) break;
		const sp = result.indexOf("<summary>");
		const isLeading =
			sp === -1
				? result.slice(0, start).trim() === ""
				: start < sp || result.slice(sp + "<summary>".length, start).trim() === "";
		if (!isLeading) break;
		const end = result.indexOf("</analysis>", start);
		if (end === -1) {
			// 不闭合：剥到下一个 <summary> 或末尾
			const dropTo = result.indexOf("<summary>", start);
			const cut = dropTo === -1 ? result.length : dropTo;
			result = result.slice(0, start) + result.slice(cut);
			break;
		}
		const absEnd = end + "</analysis>".length;
		result = result.slice(0, start) + result.slice(absEnd);
	}

	// Step 2: <summary>...</summary> → Summary:\n{inner}
	const sp = result.indexOf("<summary>");
	const ep = result.lastIndexOf("</summary>");
	if (sp !== -1 && ep !== -1 && ep > sp) {
		const before = result.slice(0, sp);
		const after = result.slice(ep + "</summary>".length);
		const inner = stripLeadingScratchpad(result.slice(sp + "<summary>".length, ep).trim());
		result = `${before}Summary:\n${inner}${after}`;
	}

	// Step 3: 中和控制 token
	result = neutralizeCompactionControlTokens(result);

	// Step 4: 折叠空行
	while (result.includes("\n\n\n")) {
		result = result.replace(/\n\n\n/g, "\n\n");
	}

	return result.trim();
}

/** 剥离 <summary> 内部的草稿头。对齐 Grok `strip_leading_scratchpad`。 */
function stripLeadingScratchpad(inner: string): string {
	let s = inner.trim();
	const lead = s.replace(/^[#*>-\s]+/, "");
	if (!/^\d/.test(lead)) {
		const pos = s.lastIndexOf("</analysis>");
		if (pos !== -1) {
			s = s.slice(pos + "</analysis>".length).trimStart();
		}
	}
	const rest = s.match(/^<summary>\s*/);
	if (rest) {
		s = s.slice(rest[0].length);
	}
	return s;
}

/** 中和控制 token：插入零宽空格，防止下轮被当作 live tag。 */
function neutralizeCompactionControlTokens(text: string): string {
	const zwsp = "\u200b";
	return text
		.replace(/<\/summary>/g, `<${zwsp}/summary>`)
		.replace(/<summary>/g, `<${zwsp}summary>`)
		.replace(/<\/analysis>/g, `<${zwsp}/analysis>`)
		.replace(/<analysis>/g, `<${zwsp}analysis>`);
}

/**
 * 判断摘要是否退化（清洗后过短）。
 * 对齐 Grok `is_degenerate_summary`。
 */
export function isDegenerateSummary(rawSummary: string, minSeedChars = 500): boolean {
	return formatCompactSummary(rawSummary).length < minSeedChars;
}

/**
 * 拼接摘要的"继续会话"前导文本。
 * 对齐 Grok `format_compact_summary_content`。
 */
export function formatCompactSummaryContent(rawSummary: string): string {
	const cleaned = formatCompactSummary(rawSummary);
	return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${cleaned}`;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 默认系统提示（对齐 Grok `format_compaction_developer_prompt`）
 */
export const DEFAULT_COMPACTION_SYSTEM_PROMPT =
	"You are a conversation compaction assistant. Summarize the conversation while preserving all key technical decisions, file paths, code signatures, user requests, and pending tasks. Respond with a structured summary inside <summary>...</summary> tags.";

/**
 * 默认用户提示模板（对齐 Grok `build_summary_prompt`）
 */
export const DEFAULT_COMPACTION_USER_PROMPT = `Summarize the following conversation. Include:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (preserve function/class signatures)
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Respond with ONLY the <summary> block.`;

/**
 * 执行 history-compaction（长期历史摘要）。
 *
 * 步骤：
 * 1. 切分 turn
 * 2. 若 turn 数 ≤ `historyTurns`，不做处理
 * 3. 否则：
 *    - 取早期 turn（除最近 `keepRecentTurns` 个）
 *    - 调 sampler 生成摘要（若 sampler 为 null，则用结构化裁剪替代）
 *    - 清洗摘要
 *    - 用 `<grok_user_queries>` 前导 + 摘要 替代早期 turn
 *    - 保留最近 turn 完整
 *
 * @param messages 原始消息列表
 * @param config 配置
 * @param sampler LLM 采样器（可为 null，此时仅做结构化裁剪）
 * @param previousSummary 上一轮 compaction 的摘要（用于增量更新）
 */
export async function historyCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
	sampler: CompactionSampler | null,
	previousSummary?: string,
	signal?: AbortSignal,
): Promise<{ messages: NexusMessage[]; stats: HistoryCompactionStats; summary?: string }> {
	const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
	const turns = splitIntoTurns(messages);

	if (turns.length <= config.historyTurns) {
		return {
			messages,
			stats: {
				applied: false,
				turnsSummarized: 0,
				turnsKept: turns.length,
				tokensBefore,
				tokensAfter: tokensBefore,
			},
		};
	}

	const keepCount = Math.min(config.keepRecentTurns, turns.length);
	const earlyTurns = turns.slice(0, turns.length - keepCount);
	const recentTurns = turns.slice(turns.length - keepCount);

	// 展平早期 turn 为消息列表
	const earlyMessages = earlyTurns.flat();

	// 生成摘要
	let summary: string;
	if (sampler) {
		const userQueries = extractUserQueriesFromTurns(earlyMessages, config.userMessageTruncateChars);
		const preamble = assembleUserQueriesPreamble(previousSummary ?? null, userQueries);
		const userPrompt = `${preamble}${DEFAULT_COMPACTION_USER_PROMPT}`;
		const raw = await sampler.sampleSummary(earlyMessages, DEFAULT_COMPACTION_SYSTEM_PROMPT, userPrompt, signal);
		summary = formatCompactSummary(raw);
	} else {
		// 无 sampler：结构化裁剪（取每 turn 的首条消息文本拼接）
		summary = structuralFallbackSummary(earlyMessages, previousSummary);
	}

	// 构造摘要消息（compactionSummary 角色，对齐 omp 形态）
	const summaryMessage: NexusMessage = {
		role: "compactionSummary",
		summary,
		content: summary,
		timestamp: Date.now(),
	} as NexusMessage;

	// 重组：system 首条（若有） + summary + 最近 turn
	const result: NexusMessage[] = [];
	// 保留首条 system 消息（若有）
	if (earlyMessages.length > 0 && toCompactionRole(earlyMessages[0]) === "system") {
		result.push(earlyMessages[0]);
	}
	result.push(summaryMessage);
	for (const turn of recentTurns) {
		result.push(...turn);
	}

	const tokensAfter = result.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

	return {
		messages: result,
		stats: {
			applied: true,
			turnsSummarized: earlyTurns.length,
			turnsKept: keepCount,
			tokensBefore,
			tokensAfter,
		},
		summary,
	};
}

/**
 * 无 LLM 时的结构化裁剪 fallback：
 * - 取每条消息的核心文本（首 N 字符）
 * - 拼接为简化摘要
 * - 主要用于测试 / Windows 无 LLM 环境
 */
function structuralFallbackSummary(messages: NexusMessage[], previousSummary?: string): string {
	const parts: string[] = [];
	if (previousSummary) {
		parts.push(`Previous summary: ${previousSummary.slice(0, 500)}...`);
	}
	for (const msg of messages) {
		const role = toCompactionRole(msg);
		if (role === "system") continue;
		const text = extractMessageText(msg).trim();
		if (!text) continue;
		// 每条消息保留首 200 字符
		const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
		parts.push(`[${role}] ${truncated}`);
	}
	const body = parts.join("\n");
	return `Summary:\n${body}`;
}
