/**
 * 跨 turn 压缩（inter-compaction）
 *
 * 移植自 Grok `xai-grok-compaction/src/inter_compaction/compact.rs` +
 * `history/filter.rs`。
 *
 * 核心算法：
 * 1. **过滤**（`filter_turns_for_inter_compaction`）：
 *    - 丢弃 system / tool 消息
 *    - 保留 user / assistant（剥离 tool-call 内容）/ 保留 compaction summary
 * 2. **剥离 `<grok_user_queries>` 块**（`separate_prior_user_queries`）：
 *    历次 compaction 摘要中的 `<grok_user_queries>` 块抽出后保留，
 *    避免再次喂给 LLM 导致 snowball。
 * 3. **跨 turn 重复检测**（nexus 扩展，Grok 原版用 chunked LLM summary）：
 *    相邻 turn 中重复出现的 system prompt / tool result 文本，
 *    用引用替代（`[ref: turn#N]`），减少 token 占用。
 * 4. **重组**：返回压缩后的消息数组。
 *
 * 与 omp compaction 接口兼容：输入 `NexusMessage[]`，输出 `NexusMessage[]`。
 */

import type { NexusMessage, NexusCompactionConfig } from "./types";
import { extractMessageText, toCompactionRole } from "./types";
import { estimateMessageTokens } from "./tokenizer";

/**
 * Inter-compaction 阶段的统计结果。
 */
export interface InterCompactionStats {
	/** 是否触发了压缩 */
	applied: boolean;
	/** 替换的重复段数量 */
	replacements: number;
	/** 节省的 token 数 */
	tokensSaved: number;
}

/**
 * 过滤 inter-compaction 输入：对齐 Grok `filter_turns_for_inter_compaction`。
 *
 * - 丢弃 system 消息（compaction LLM 自带 system prompt）
 * - 丢弃 tool 消息（避免 tool request/response 噪声）
 * - 保留 user 消息
 * - 保留 assistant 消息（剥离 tool-call 内容，仅保留可见文本）
 * - 保留 compaction summary（developer 角色）
 */
export function filterTurnsForInterCompaction(messages: NexusMessage[]): NexusMessage[] {
	const result: NexusMessage[] = [];
	for (const msg of messages) {
		const role = toCompactionRole(msg);
		if (role === "system" || role === "tool") continue;
		if (role === "assistant") {
			// 剥离 tool-call 内容，仅保留可见文本/thinking
			const stripped = stripAssistantToolContent(msg);
			if (stripped) result.push(stripped);
			continue;
		}
		// user / developer(compaction summary) 直接保留
		result.push(msg);
	}
	return result;
}

/**
 * 剥离 assistant 消息中的 toolCall 块，仅保留 text/thinking。
 * 若剥离后无可保留内容，返回 null。
 *
 * 对齐 Grok `CompactionItemBuilder::strip_tool_content`。
 */
function stripAssistantToolContent(message: NexusMessage): NexusMessage | null {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		// 无 content 数组，原样返回（保留 text-string 形态）
		return message;
	}
	const kept = content.filter((block: unknown) => {
		if (!block || typeof block !== "object") return false;
		const b = block as { type?: string };
		return b.type === "text" || b.type === "thinking" || b.type === "redactedThinking";
	});
	if (kept.length === 0) return null;
	return { ...message, content: kept } as NexusMessage;
}

/**
 * 剥离 `<grok_user_queries>` 块。
 *
 * 对齐 Grok `separate_prior_user_queries`。
 * 返回剥离后的消息列表 + 抽出的 user queries 拼接文本。
 */
export function separatePriorUserQueries(messages: NexusMessage[]): {
	turnsForLlm: NexusMessage[];
	priorUserQueries: string | null;
	hasPriorCompaction: boolean;
} {
	const turnsForLlm: NexusMessage[] = [];
	let priorUserQueries: string | null = null;
	let hasPriorCompaction = false;

	for (const msg of messages) {
		const role = (msg as { role?: string }).role;
		const isSummary = role === "compactionSummary" || role === "branchSummary";
		if (!isSummary) {
			turnsForLlm.push(msg);
			continue;
		}
		hasPriorCompaction = true;
		const text = extractMessageText(msg);
		const { userSection, rest } = splitPriorCompactionText(text);
		if (userSection) {
			priorUserQueries = priorUserQueries ? `${priorUserQueries}\n${userSection}` : userSection;
		}
		// rest 为空则丢弃该 summary item（对齐 Grok 行为）
		if (rest.trim()) {
			turnsForLlm.push({ ...msg, summary: rest, content: rest } as NexusMessage);
		}
	}
	return { turnsForLlm, priorUserQueries, hasPriorCompaction };
}

/**
 * 拆分 `<grok_user_queries>...</grok_user_queries>` 块与其余内容。
 *
 * 对齐 Grok `split_prior_compaction_text`。
 */
export function splitPriorCompactionText(text: string): { userSection: string | null; rest: string } {
	const startTag = "<grok_user_queries>";
	const endTag = "</grok_user_queries>";
	const userSections: string[] = [];
	let rest = "";
	let cursor = 0;

	while (cursor < text.length) {
		const relStart = text.indexOf(startTag, cursor);
		if (relStart === -1) {
			const remaining = text.slice(cursor).trim();
			if (remaining) rest = rest ? `${rest}\n${remaining}` : remaining;
			break;
		}
		const absStart = relStart;
		const relEnd = text.indexOf(endTag, absStart);
		if (relEnd === -1) {
			// 不闭合，剩余都视为 rest
			const remaining = text.slice(cursor).trim();
			if (remaining) rest = rest ? `${rest}\n${remaining}` : remaining;
			break;
		}
		const absEnd = relEnd + endTag.length;
		// startTag 之前的内容 → rest
		const before = text.slice(cursor, absStart).trim();
		if (before) rest = rest ? `${rest}\n${before}` : before;
		userSections.push(text.slice(absStart, absEnd));
		cursor = absEnd;
	}

	return {
		userSection: userSections.length ? userSections.join("\n") : null,
		rest,
	};
}

/**
 * 抽取当前轮次 user 消息形成 `<grok_user_queries>` 块。
 *
 * 对齐 Grok `extract_user_queries_from_turns`。
 * 长消息会被中间截断（`truncate_middle`）。
 */
export function extractUserQueriesFromTurns(
	messages: NexusMessage[],
	userTruncateChars: number,
): string | null {
	const lines: string[] = ["<grok_user_queries>"];
	let emitted = false;
	for (const msg of messages) {
		if (toCompactionRole(msg) !== "user") continue;
		const text = extractMessageText(msg).trim();
		if (!text) continue;
		emitted = true;
		const truncated = truncateMiddle(text, userTruncateChars);
		lines.push(`<grok_query>${truncated}</grok_query>`);
	}
	if (!emitted) return null;
	lines.push("</grok_user_queries>");
	return lines.join("\n");
}

/**
 * 中间截断长字符串。对齐 Grok `truncate_middle`。
 */
export function truncateMiddle(text: string, maxChars: number): string {
	const charCount = text.length;
	if (charCount <= maxChars) return text;
	const frontLen = Math.floor(maxChars / 2);
	const backLen = maxChars - frontLen;
	const front = text.slice(0, frontLen);
	const back = text.slice(charCount - backLen);
	return `${front}...[truncated]...${back}`;
}

/**
 * 组装 `<grok_user_queries>` 前导块。
 *
 * 对齐 Grok `assemble_user_queries_preamble`。
 */
export function assembleUserQueriesPreamble(
	prior: string | null,
	current: string | null,
): string {
	let preamble = "";
	if (prior) preamble += `${prior}\n\n`;
	if (current) preamble += `${current}\n\n`;
	return preamble;
}

// ============================================================================
// 跨 turn 重复检测与替换（nexus 扩展）
// ============================================================================

/**
 * 跨 turn 重复内容检测：识别多 turn 中重复出现的大块文本（system prompt、
 * 长 tool result），用 `[ref: turn#N]` 引用替代。
 *
 * 这是 nexus 在 Grok inter_compaction 基础上的扩展：
 * Grok 原版用 chunked LLM summary；我们在调用 LLM 之前先做一次结构化去重，
 * 减少 LLM 输入体积。
 *
 * @param messages 已过滤的消息列表
 * @param threshold 重复检测的字节阈值，低于此值不替换
 * @returns 替换后的消息列表 + 统计
 */
export function deduplicateCrossTurnContent(
	messages: NexusMessage[],
	threshold: number,
): { messages: NexusMessage[]; stats: InterCompactionStats } {
	// 按文本内容哈希分组（保留首次出现位置）
	const firstSeen = new Map<string, number>(); // hash → turnIndex
	const replacements: { index: number; refIndex: number; hash: string }[] = [];

	const hashedMessages = messages.map((msg, idx) => {
		const text = extractMessageText(msg);
		// 仅对超过阈值的文本做重复检测
		if (text.length * 2 < threshold) return { msg, idx, hash: null, text };
		const hash = simpleHash(text);
		return { msg, idx, hash, text };
	});

	const result: NexusMessage[] = [];
	let tokensSaved = 0;

	for (const { msg, idx, hash, text } of hashedMessages) {
		if (hash === null) {
			result.push(msg);
			continue;
		}
		const firstIdx = firstSeen.get(hash);
		if (firstIdx === undefined) {
			firstSeen.set(hash, idx);
			result.push(msg);
			continue;
		}
		// 重复内容 → 替换为引用
		const refText = `[ref: duplicated from turn #${firstIdx}, ${text.length} chars elided]`;
		tokensSaved += estimateMessageTokens(msg) - estimateTextTokensLocal(refText);
		replacements.push({ index: idx, refIndex: firstIdx, hash });
		result.push(replaceMessageText(msg, refText));
	}

	return {
		messages: result,
		stats: {
			applied: replacements.length > 0,
			replacements: replacements.length,
			tokensSaved,
		},
	};
}

/** 简易文本哈希（djb2 变种），足以检测完全重复。 */
function simpleHash(text: string): string {
	// 取首 256 + 末 256 + 长度，避免对超长文本做完整哈希
	const head = text.slice(0, 256);
	const tail = text.length > 512 ? text.slice(-256) : "";
	const sample = `${head.length}|${head}|${tail}|${text.length}`;
	let hash = 5381;
	for (let i = 0; i < sample.length; i++) {
		hash = ((hash << 5) + hash + sample.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/** 本地 token 估算（避免循环导入） */
function estimateTextTokensLocal(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * 替换消息文本（保留 role / 结构）。
 */
function replaceMessageText(message: NexusMessage, newText: string): NexusMessage {
	const role = (message as { role?: string }).role;
	if (role === "compactionSummary" || role === "branchSummary") {
		return { ...message, summary: newText } as NexusMessage;
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return { ...message, content: newText } as NexusMessage;
	}
	if (Array.isArray(content)) {
		// 仅保留首个 text 块并替换文本，丢弃其它块
		return { ...message, content: [{ type: "text", text: newText }] } as NexusMessage;
	}
	return { ...message, content: newText } as NexusMessage;
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 inter-compaction（跨 turn 压缩）。
 *
 * 步骤对齐 Grok `sample_compaction_chunked`：
 * 1. 过滤（filter_turns_for_inter_compaction）
 * 2. 剥离 prior `<grok_user_queries>`
 * 3. 跨 turn 重复检测与替换（nexus 扩展）
 * 4. 返回压缩后消息 + 统计
 *
 * 注意：本函数不调用 LLM；LLM 摘要由 history-compaction 负责。
 */
export function interCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
): { messages: NexusMessage[]; stats: InterCompactionStats } {
	// Step 1: 过滤
	const filtered = filterTurnsForInterCompaction(messages);

	// Step 2: 剥离 prior user queries
	const { turnsForLlm } = separatePriorUserQueries(filtered);

	// Step 3: 跨 turn 重复检测
	const { messages: deduped, stats } = deduplicateCrossTurnContent(turnsForLlm, config.interThreshold);

	return { messages: deduped, stats };
}
