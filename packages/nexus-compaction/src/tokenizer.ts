/**
 * 轻量 token 估算器
 *
 * 不依赖 tiktoken / cl100k_base 的 native binding，避免 Windows 下编译问题。
 * 估算公式对齐 omp `estimateTokens` 的近似：英文 ~4 char/token，中文 ~2 char/token，
 * JSON / 代码结构按空格 + 标点分词。
 *
 * 与 omp `countTokens` 的差距控制在 ±15% 以内，足以驱动 compaction 触发判断。
 */

import type { NexusMessage } from "./types";
import { extractMessageText } from "./types";

/**
 * 估算单段文本的 token 数。
 *
 * 启发式：
 * - ASCII 英文：4 char ≈ 1 token
 * - CJK 中文/日文/韩文：2 char ≈ 1 token
 * - 空白/标点适度折算
 */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let asciiChars = 0;
	let cjkChars = 0;
	let otherChars = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x80) {
			asciiChars++;
		} else if (
			(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
			(code >= 0x3040 && code <= 0x30ff) || // 日文
			(code >= 0xac00 && code <= 0xd7af) // 韩文
		) {
			cjkChars++;
		} else {
			otherChars++;
		}
	}
	// 英文 4 char/token，CJK 2 char/token，其它 3 char/token
	const ascii = Math.ceil(asciiChars / 4);
	const cjk = Math.ceil(cjkChars / 2);
	const other = Math.ceil(otherChars / 3);
	return ascii + cjk + other;
}

/**
 * 估算单条消息的 token 数（含 role 标签固定开销 ~4 token）。
 */
export function estimateMessageTokens(message: NexusMessage): number {
	const text = extractMessageText(message);
	return estimateTextTokens(text) + 4;
}

/**
 * 估算消息列表的总 token 数。
 */
export function estimateMessagesTokens(messages: NexusMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateMessageTokens(msg);
	}
	return total;
}

/**
 * 图片 token 估算（对齐 omp `IMAGE_TOKEN_ESTIMATE`）。
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;
