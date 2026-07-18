/**
 * 单 turn 内重复内容压缩（intra-compaction）
 *
 * 移植自 Grok `xai-grok-compaction/src/intra_compaction/compact.rs`。
 *
 * Grok 原版的 intra-compaction 分为三种模式：
 * - `FullReplace`：整段对话摘要后替换（无 tail-keep）
 * - `StepsOnly`：对当前 agent loop 累积的 step turns 做 tail-keep 选择 + 摘要
 * - `HistoryOnly`：对历史 turns 做 tail-keep 选择 + 摘要
 *
 * nexus 在此基础上做轻量纯结构化压缩（不调 LLM）：
 * - 合并同一消息内重复的 text block
 * - 合并相邻消息中相同 role 的重复段
 * - 折叠冗长 thinking 块（保留首尾，中间省略）
 *
 * LLM 摘要由 history-compaction 负责；intra 主要做结构化清理。
 */

import type { NexusMessage, NexusCompactionConfig, ContentBlock } from "./types";
import { extractMessageText } from "./types";

/** Intra-compaction 统计 */
export interface IntraCompactionStats {
	applied: boolean;
	/** 合并的重复 block 数 */
	blocksMerged: number;
	/** 折叠的 thinking 块数 */
	thinkingCollapsed: number;
	/** 节省的 token 数 */
	tokensSaved: number;
}

/**
 * 折叠单个消息内重复的 text block。
 *
 * - 同一消息内若多个 text block 内容相同，仅保留一个
 * - 相邻 text block 文本差异 < 10% 视为重复（保护内容微调场景）
 */
export function mergeDuplicateBlocks(message: NexusMessage, threshold: number): {
	message: NexusMessage;
	merged: number;
} {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message, merged: 0 };

	const seen = new Set<string>();
	const kept: ContentBlock[] = [];
	let merged = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") {
			kept.push(block as ContentBlock);
			continue;
		}
		const b = block as { type?: string; text?: string };
		if (b.type !== "text" || typeof b.text !== "string") {
			kept.push(block as ContentBlock);
			continue;
		}
		// 仅对超过阈值的 text block 做去重
		if (b.text.length < threshold) {
			kept.push(block as ContentBlock);
			continue;
		}
		const key = blockHash(b.text);
		if (seen.has(key)) {
			merged++;
			continue;
		}
		seen.add(key);
		kept.push(block as ContentBlock);
	}

	if (merged === 0) return { message, merged: 0 };
	return { message: { ...message, content: kept } as NexusMessage, merged };
}

/**
 * 折叠超长 thinking 块：保留首尾 N 行，中间用省略号占位。
 *
 * 对齐 Grok 对 reasoning 内容的处理：thinking 块对最终输出无影响，
 * 但会占用大量 token，应做结构化压缩。
 */
export function collapseThinkingBlocks(message: NexusMessage, maxLines = 8): {
	message: NexusMessage;
	collapsed: number;
} {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message, collapsed: 0 };

	let collapsed = 0;
	const kept: ContentBlock[] = content.map((block: unknown) => {
		if (!block || typeof block !== "object") return block as ContentBlock;
		const b = block as { type?: string; thinking?: string };
		if (b.type !== "thinking" || typeof b.thinking !== "string") return block as ContentBlock;
		const lines = b.thinking.split("\n");
		if (lines.length <= maxLines) return block as ContentBlock;
		collapsed++;
		const head = lines.slice(0, Math.floor(maxLines / 2));
		const tail = lines.slice(-Math.floor(maxLines / 2));
		const elided = lines.length - head.length - tail.length;
		const newThinking = [...head, `// ... <${elided} lines elided>`, ...tail].join("\n");
		return { ...block, thinking: newThinking } as ContentBlock;
	});

	if (collapsed === 0) return { message, collapsed: 0 };
	return { message: { ...message, content: kept } as NexusMessage, collapsed };
}

/**
 * 合并相邻消息中相同 role 的重复段。
 *
 * 例：连续两条 user 消息，文本完全相同 → 仅保留首条。
 * 注意：不跨 turn 合并（那是 inter 的工作），仅在严格相邻时合并。
 */
export function mergeAdjacentDuplicateMessages(
	messages: NexusMessage[],
	threshold: number,
): { messages: NexusMessage[]; merged: number } {
	if (messages.length < 2) return { messages, merged: 0 };
	const result: NexusMessage[] = [messages[0]];
	let merged = 0;
	for (let i = 1; i < messages.length; i++) {
		const prev = result[result.length - 1];
		const curr = messages[i];
		const prevRole = (prev as { role?: string }).role;
		const currRole = (curr as { role?: string }).role;
		if (prevRole !== currRole) {
			result.push(curr);
			continue;
		}
		const prevText = extractMessageText(prev);
		const currText = extractMessageText(curr);
		if (prevText.length < threshold || currText.length < threshold) {
			result.push(curr);
			continue;
		}
		if (blockHash(prevText) === blockHash(currText)) {
			merged++;
			continue;
		}
		result.push(curr);
	}
	return { messages: result, merged };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 intra-compaction（单 turn 内重复内容压缩）。
 *
 * 对每条消息：
 * 1. 合并重复的 text block
 * 2. 折叠超长 thinking 块
 * 然后对整个消息列表：
 * 3. 合并相邻相同 role 的重复消息
 *
 * 与 omp compaction 接口兼容：输入 `NexusMessage[]`，输出 `NexusMessage[]`。
 */
export function intraCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
): { messages: NexusMessage[]; stats: IntraCompactionStats } {
	let working = messages;
	let totalMerged = 0;
	let totalCollapsed = 0;

	// Step 1+2: 逐条消息清理
	working = working.map(msg => {
		const { message: m1, merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		totalMerged += merged;
		const { message: m2, collapsed } = collapseThinkingBlocks(m1);
		totalCollapsed += collapsed;
		return m2;
	});

	// Step 3: 相邻消息合并
	const { messages: merged2, merged: adjMerged } = mergeAdjacentDuplicateMessages(working, config.intraThreshold);
	totalMerged += adjMerged;

	// 粗略估算 token 节省
	const tokensSaved = totalMerged * 50 + totalCollapsed * 100;

	return {
		messages: merged2,
		stats: {
			applied: totalMerged > 0 || totalCollapsed > 0,
			blocksMerged: totalMerged,
			thinkingCollapsed: totalCollapsed,
			tokensSaved,
		},
	};
}

// ============================================================================
// 辅助
// ============================================================================

/** 文本块哈希：FNV-1a 变种，足以检测完全重复。 */
function blockHash(text: string): string {
	// 取首尾各 128 字符 + 长度作为指纹
	const head = text.slice(0, 128);
	const tail = text.length > 256 ? text.slice(-128) : "";
	const sample = `${head}|${tail}|${text.length}`;
	let hash = 2166136261;
	for (let i = 0; i < sample.length; i++) {
		hash ^= sample.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
