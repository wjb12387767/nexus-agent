/**
 * Central live healing for leaked reasoning markup in the visible text channel.
 *
 * Some providers emit their canonical reasoning idioms (` ```thinking `,
 * `<think>`, Gemma/Harmony channels, …) into the *visible* text stream instead
 * of a structured thinking part. {@link wrapLeakedThinkingStream} re-projects a
 * provider stream into a fresh {@link AssistantMessageEventStream}, splitting the
 * leaked fences out into proper `thinking` blocks *live* as deltas arrive.
 *
 * Applied to every provider stream *except* official first-party endpoints
 * (the official Anthropic API and the official OpenAI / OpenAI-Codex endpoints),
 * which return structured thinking and never leak — `healLeakedThinking` in
 * `../stream.ts` gates the wrap so the healer cannot misfire on legitimate
 * fenced content those models emit as visible text.
 *
 * The healing is idempotent: a second pass over already-clean text finds no
 * fences, so wrapping a provider that already heals (or wrapping twice) is a
 * harmless pass-through. Signatures are load-bearing for Google/Gemini/Vertex
 * thought round-tripping, so text sub-blocks carry the source `textSignature`,
 * forwarded thinking blocks their `thinkingSignature`, and forwarded tool calls
 * their `thoughtSignature`.
 *
 * Modeled on {@link wrapInbandToolStream} / `InbandStreamProjector` in
 * `../dialect/owned-stream.ts`, minus all in-band tool-call grammar: tool-call
 * events are forwarded verbatim.
 */

import type { AssistantMessage, ImageContent, TextContent, ThinkingContent, ToolCall } from "../types";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "./stream-markup-healing";

type StreamingToolCall = ToolCall & StreamingPartialJsonCarrier;

function cloneToolCall(source: StreamingToolCall): StreamingToolCall {
	const block: StreamingToolCall = { ...source, arguments: source.arguments };
	const partialJson = getStreamingPartialJson(source);
	if (partialJson !== undefined) setStreamingPartialJson(block, partialJson);
	return block;
}

function syncToolCall(target: StreamingToolCall, source: StreamingToolCall): void {
	Object.assign(target, source);
	const partialJson = getStreamingPartialJson(source);
	if (partialJson === undefined) clearStreamingPartialJson(target);
	else setStreamingPartialJson(target, partialJson);
}

/**
 * Wrap a provider stream so leaked reasoning fences are healed into thinking
 * blocks live, for every provider. Returns a new stream that re-projects the
 * inner one; the inner stream is fully consumed.
 */
export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: LeakedThinkingProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new LeakedThinkingProjector(out, event.partial);
						break;
					case "text_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.text(event.delta, block?.type === "text" ? block.textSignature : undefined);
						break;
					}
					case "thinking_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.thinking(event.delta, block?.type === "thinking" ? block.thinkingSignature : undefined);
						break;
					}
					case "image_end":
						projector ??= new LeakedThinkingProjector(out, event.partial);
						projector.image(event.content);
						break;
					case "toolcall_start": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.toolStart(event.contentIndex, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_delta": {
						const block = event.partial.content[event.contentIndex];
						projector?.toolDelta(event.contentIndex, event.delta, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_end":
						projector?.toolEnd(event.contentIndex, event.toolCall);
						break;
					case "done": {
						projector ??= new LeakedThinkingProjector(out, event.message);
						const content = projector.finish(event.message);
						out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
						return;
					}
					case "error": {
						projector ??= new LeakedThinkingProjector(out, event.error);
						const content = projector.finish(event.error);
						out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
						return;
					}
					// text_start/text_end/thinking_start/thinking_end are ignored: the
					// projector owns block boundaries (matches wrapInbandToolStream).
				}
			}
			// Inner ended via end(result) without a terminal event.
			if (!out.done) {
				const result = await inner.result();
				projector ??= new LeakedThinkingProjector(out, result);
				const content = projector.finish(result);
				out.end({ ...result, content });
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type OpenBlock = { index: number } | undefined;

/**
 * Re-projects an inner stream's events into `out`, healing leaked reasoning out
 * of the visible text channel while forwarding native thinking and tool calls.
 */
class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;
	/** Total visible text length fed to the healer, to replay any un-streamed tail in {@link finish}. */
	#fedLen = 0;
	/** Latest non-undefined text signature seen, stamped onto held-back text flushed later. */
	#lastTextSignature: string | undefined;
	/** Forwarded native tool calls, keyed by the inner stream's `contentIndex`. */
	#toolBlocks = new Map<number, { index: number; block: StreamingToolCall }>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	/** Feed a visible-text delta through the healer, splitting leaked fences live. */
	text(delta: string, signature: string | undefined): void {
		this.#fedLen += delta.length;
		if (signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature);
	}

	/** Forward a native thinking delta, preserving its signature. */
	thinking(delta: string, signature: string | undefined): void {
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

	/** Forward a completed native image after releasing held text. */
	image(content: ImageContent): void {
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push(content);
		this.#out.push({
			type: "image_end",
			contentIndex: this.#partial.content.length - 1,
			content,
			partial: this.#partial,
		});
	}

	/** Forward a native tool call's start, releasing any held-back text first. */
	toolStart(srcIndex: number, source: StreamingToolCall | undefined): void {
		if (!source) return;
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(source);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#toolBlocks.set(srcIndex, { index, block });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	toolDelta(srcIndex: number, delta: string, source: StreamingToolCall | undefined): void {
		let entry = this.#toolBlocks.get(srcIndex);
		if (!entry && source) {
			this.toolStart(srcIndex, source);
			entry = this.#toolBlocks.get(srcIndex);
		}
		if (!entry) return;
		if (source) syncToolCall(entry.block, source);
		this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	toolEnd(srcIndex: number, toolCall: ToolCall): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (entry) {
			syncToolCall(entry.block, toolCall);
			this.#out.push({
				type: "toolcall_end",
				contentIndex: entry.index,
				toolCall: entry.block,
				partial: this.#partial,
			});
			this.#toolBlocks.delete(srcIndex);
			return;
		}
		// `end` without a matching `start` — release held text, then forward whole.
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(toolCall);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

	/**
	 * Finalize: replay any un-streamed visible-text tail from `message.content`,
	 * flush held-back fragments, close open blocks, and return the healed content.
	 */
	finish(message: AssistantMessage): AssistantMessage["content"] {
		let fullText = "";
		let tailSignature: string | undefined;
		for (const block of message.content) {
			if (block.type === "text") {
				fullText += block.text;
				tailSignature = block.textSignature;
			}
		}
		if (tailSignature !== undefined) this.#lastTextSignature = tailSignature;
		if (fullText.length > this.#fedLen) {
			this.#apply(this.#healer.feedEvents(fullText.slice(this.#fedLen)), this.#lastTextSignature);
		}
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		return this.#partial.content;
	}

	#apply(events: readonly StreamMarkupHealingEvent[], signature?: string): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature);
			else if (event.type === "thinking") this.#emitHealedThinking(event.thinking);
		}
	}

	#emitText(text: string, signature: string | undefined): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			const block: TextContent =
				signature === undefined ? { type: "text", text: "" } : { type: "text", text: "", textSignature: signature };
			this.#partial.content.push(block);
			this.#text = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		} else if (signature !== undefined) {
			(this.#partial.content[this.#text.index] as TextContent).textSignature = signature;
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	/** Healed (leaked) thinking carries no signature, matching the source fence. */
	#emitHealedThinking(text: string): void {
		if (text.length === 0) return;
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += text;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.#partial });
	}

	#openThinking(): number {
		this.#closeText();
		if (!this.#thinking) {
			this.#partial.content.push({ type: "thinking", thinking: "" });
			this.#thinking = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
		}
		return this.#thinking.index;
	}

	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		this.#out.push({ type: "text_end", contentIndex: this.#text.index, content: block.text, partial: this.#partial });
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const block = this.#partial.content[this.#thinking.index] as ThinkingContent;
		this.#out.push({
			type: "thinking_end",
			contentIndex: this.#thinking.index,
			content: block.thinking,
			partial: this.#partial,
		});
		this.#thinking = undefined;
	}
}

// ────────────────────────────────────────────────────────────────────────
// StreamingThinkScrubber — 独立的流式 think 标签清洗器
//
// 与 {@link LeakedThinkingProjector} 不同，这是一个纯文本清洗器：feed 进
// delta 文本，返回清洗后的可见文本。不依赖事件流，可独立用于任何文本通道。
// 支持更多标签变体与 boundary-gated 语义，用于 "aggressive" 清洗模式。
// ────────────────────────────────────────────────────────────────────────

/**
 * 支持清洗的 think 标签名称（匹配时大小写不敏感）。
 * `<REASONING_SCRATCHPAD>` 以原始大写形式列出，匹配时统一转小写比较。
 */
export const OPEN_TAG_NAMES = [
	"think",
	"thinking",
	"reasoning",
	"thought",
	"REASONING_SCRATCHPAD",
] as const;

/** 标签最大长度上限（`</REASONING_SCRATCHPAD>` 为 22 字符，取 24 留余量）。 */
const MAX_TAG_LEN = 24;

interface TagHit {
	/** 标签在文本中的起始位置。 */
	readonly index: number;
	/** 标签名称（来自 {@link OPEN_TAG_NAMES} 的原始形式）。 */
	readonly tagName: string;
	/** 标签完整长度（含尖括号与斜杠）。 */
	readonly length: number;
	/** 是否为闭合标签 `</tag>`。 */
	readonly isClose: boolean;
}

interface ClosedPair {
	readonly openStart: number;
	readonly openEnd: number;
	readonly closeStart: number;
	readonly closeEnd: number;
	readonly tagName: string;
}

/**
 * 在 `text` 中查找最早出现的开标签或闭标签（大小写不敏感）。
 * @param text 待扫描文本
 * @param kind 限定查找类型："open" 仅开标签，"close" 仅闭标签，"any" 两者
 */
function _find_first_tag(text: string, kind: "open" | "close" | "any" = "any"): TagHit | undefined {
	const lower = text.toLowerCase();
	let earliest: TagHit | undefined;
	for (const name of OPEN_TAG_NAMES) {
		if (kind !== "close") {
			const openTag = `<${name}>`.toLowerCase();
			const idx = lower.indexOf(openTag);
			if (idx !== -1) {
				const hit: TagHit = { index: idx, tagName: name, length: openTag.length, isClose: false };
				if (!earliest || hit.index < earliest.index) earliest = hit;
			}
		}
		if (kind !== "open") {
			const closeTag = `</${name}>`.toLowerCase();
			const idx = lower.indexOf(closeTag);
			if (idx !== -1) {
				const hit: TagHit = { index: idx, tagName: name, length: closeTag.length, isClose: true };
				if (!earliest || hit.index < earliest.index) earliest = hit;
			}
		}
	}
	return earliest;
}

/**
 * 查找最早的闭合对 `<tag>...</tag>`（任何位置，不受 boundary 约束）。
 * 闭合对始终被整体吞掉。
 */
function _find_earliest_closed_pair(text: string): ClosedPair | undefined {
	const lower = text.toLowerCase();
	let earliest: ClosedPair | undefined;
	for (const name of OPEN_TAG_NAMES) {
		const openTag = `<${name}>`.toLowerCase();
		const closeTag = `</${name}>`.toLowerCase();
		const openIdx = lower.indexOf(openTag);
		if (openIdx === -1) continue;
		const closeIdx = lower.indexOf(closeTag, openIdx + openTag.length);
		if (closeIdx === -1) continue;
		const pair: ClosedPair = {
			openStart: openIdx,
			openEnd: openIdx + openTag.length,
			closeStart: closeIdx,
			closeEnd: closeIdx + closeTag.length,
			tagName: name,
		};
		if (!earliest || pair.openStart < earliest.openStart) earliest = pair;
	}
	return earliest;
}

/**
 * 判断 `index` 位置是否是块边界：行首（流开始或上一段以换行结尾）或前一个字符
 * 是空白。用于 boundary-gated 语义，防止 prose 中内联提及的 `<think>` 被误吞。
 */
function _is_block_boundary(text: string, index: number, lastEmittedEndedNewline: boolean): boolean {
	if (index === 0) return lastEmittedEndedNewline;
	const prev = text[index - 1];
	return prev === " " || prev === "\t" || prev === "\n" || prev === "\r" || prev === "\f" || prev === "\v";
}

/**
 * 查找在 boundary 位置（行首/空白前文）的最早开标签。非 boundary 位置的开标签
 * 被视为 prose 中的内联提及，不会被匹配。
 */
function _find_open_at_boundary(text: string, lastEmittedEndedNewline: boolean): TagHit | undefined {
	const lower = text.toLowerCase();
	let earliest: TagHit | undefined;
	for (const name of OPEN_TAG_NAMES) {
		const openTag = `<${name}>`.toLowerCase();
		let from = 0;
		while (from < lower.length) {
			const idx = lower.indexOf(openTag, from);
			if (idx === -1) break;
			if (_is_block_boundary(text, idx, lastEmittedEndedNewline)) {
				const hit: TagHit = { index: idx, tagName: name, length: openTag.length, isClose: false };
				if (!earliest || hit.index < earliest.index) earliest = hit;
				break;
			}
			from = idx + 1;
		}
	}
	return earliest;
}

/**
 * 计算 `buf` 末尾可能是某个标签前缀的最大长度，用于跨 delta 持回 partial tag。
 * 例如 buf 末尾 `<thi` 是 `<think>` 的前缀，返回 4；`</re` 是 `</reasoning>` 的
 * 前缀，返回 3。不以 `<` 开头的末尾返回 0。
 * 注意：完整标签（如 `<think>`）不是 partial，返回 0，让 consume 循环处理。
 */
function _max_partial_suffix(buf: string): number {
	if (buf.length === 0) return 0;
	const maxLook = Math.min(buf.length, MAX_TAG_LEN);
	const lower = buf.toLowerCase();
	for (let len = maxLook; len >= 1; len--) {
		const start = buf.length - len;
		if (lower[start] !== "<") continue;
		const suffix = lower.slice(start);
		for (const name of OPEN_TAG_NAMES) {
			const openTag = `<${name}>`.toLowerCase();
			const closeTag = `</${name}>`.toLowerCase();
			// 仅持回真前缀（suffix 比完整标签短），完整标签不持回
			if (
				(openTag.startsWith(suffix) && suffix.length < openTag.length) ||
				(closeTag.startsWith(suffix) && suffix.length < closeTag.length)
			) {
				return len;
			}
		}
	}
	return 0;
}

/**
 * 移除文本中所有未匹配的闭标签（orphan close tags），例如 `</think>`。
 * 用于清理确定要 emit 的可见文本中残留的 orphan 闭标签。
 */
function _strip_orphan_close_tags(text: string): string {
	if (text.length === 0) return text;
	const lower = text.toLowerCase();
	let result = "";
	let i = 0;
	while (i < text.length) {
		let matched = false;
		for (const name of OPEN_TAG_NAMES) {
			const closeTag = `</${name}>`.toLowerCase();
			if (lower.startsWith(closeTag, i)) {
				i += closeTag.length;
				matched = true;
				break;
			}
		}
		if (!matched) {
			result += text[i];
			i++;
		}
	}
	return result;
}

/**
 * 流式 think 标签清洗器。三态状态机：
 * - `inBlock` — 是否在 think 块内（吞掉块内容）
 * - `buf` — 持有未完成文本，可能含 partial tag
 * - `lastEmittedEndedNewline` — 最后一次输出是否以换行结尾，用于 boundary 判断
 *
 * 支持的标签变体见 {@link OPEN_TAG_NAMES}。清洗语义：
 * - 闭合对 `<tag>X</tag>` 始终被吞（不受 boundary 约束）
 * - 开标签只在行首/空白前文时视为块开始（防止 prose 中内联提及被误吞）
 * - orphan close tag（无匹配开标签的闭标签）被清理
 * - 跨 delta 的 partial tag 持回（{@link _max_partial_suffix} 算法）
 *
 * 大小写不敏感匹配（toLowerCase + indexOf）。
 */
export class StreamingThinkScrubber {
	#inBlock = false;
	#buf = "";
	#lastEmittedEndedNewline = true;
	#blockTagName = "";

	/** 当前是否在 think 块内。 */
	get inBlock(): boolean {
		return this.#inBlock;
	}

	/**
	 * 喂入一段 delta 文本，返回清洗后的可见文本。
	 * 内部持有 partial tag 跨 delta 拼接。
	 */
	feed(text: string): string {
		if (text.length === 0) return "";
		this.#buf += text;
		return this.#consume(false);
	}

	/**
	 * 流结束时调用：flush 持有的可见文本，重置状态。
	 * `lastEmittedEndedNewline` 强制重置为 `true`（不根据 tail 推导）。
	 * 未关闭的 think 块内容被丢弃（视为 reasoning，非可见文本）。
	 */
	flush(): string {
		const out = this.#consume(true);
		this.#buf = "";
		this.#inBlock = false;
		this.#blockTagName = "";
		this.#lastEmittedEndedNewline = true;
		// 最终安全网：清理残留的 orphan close tags（如流中断时未匹配的闭标签）
		return _strip_orphan_close_tags(out);
	}

	/** 手动重置状态机到初始状态。 */
	reset(): void {
		this.#buf = "";
		this.#inBlock = false;
		this.#blockTagName = "";
		this.#lastEmittedEndedNewline = true;
	}

	#consume(final: boolean): string {
		let out = "";
		while (true) {
			if (this.#inBlock) {
				const closeTag = `</${this.#blockTagName}>`.toLowerCase();
				const lower = this.#buf.toLowerCase();
				const closeIdx = lower.indexOf(closeTag);
				if (closeIdx !== -1) {
					// 找到匹配的闭标签：吞掉块内容 + 闭标签，继续处理剩余
					this.#buf = this.#buf.slice(closeIdx + closeTag.length);
					this.#inBlock = false;
					this.#blockTagName = "";
					this.#lastEmittedEndedNewline = true;
					continue;
				}
				// 未找到闭标签
				if (final) {
					// 流结束：未关闭的块内容丢弃
					this.#buf = "";
					break;
				}
				// 持有 partial close tag，丢弃块内容（非可见文本）
				const hold = _max_partial_suffix(this.#buf);
				this.#buf = this.#buf.slice(this.#buf.length - hold);
				break;
			}

			// 非 block 状态：查找最早的事件
			const pair = _find_earliest_closed_pair(this.#buf);
			const openHit = _find_open_at_boundary(this.#buf, this.#lastEmittedEndedNewline);
			const orphanClose = _find_first_tag(this.#buf, "close");

			// 取最早的事件
			let best:
				| { kind: "pair"; start: number; end: number; data: ClosedPair }
				| { kind: "open"; start: number; end: number; data: TagHit }
				| { kind: "orphan"; start: number; end: number; data: TagHit }
				| undefined;
			if (pair) {
				best = { kind: "pair", start: pair.openStart, end: pair.closeEnd, data: pair };
			}
			if (openHit && (!best || openHit.index < best.start)) {
				best = { kind: "open", start: openHit.index, end: openHit.index + openHit.length, data: openHit };
			}
			if (orphanClose && (!best || orphanClose.index < best.start)) {
				best = {
					kind: "orphan",
					start: orphanClose.index,
					end: orphanClose.index + orphanClose.length,
					data: orphanClose,
				};
			}

			if (!best) {
				// 没有事件：emit 安全文本，hold partial suffix
				if (this.#buf.length === 0) break;
				const hold = final ? 0 : _max_partial_suffix(this.#buf);
				const emitLen = this.#buf.length - hold;
				if (emitLen > 0) {
					const emitText = this.#buf.slice(0, emitLen);
					out += emitText;
					this.#updateLastNewline(emitText);
				}
				this.#buf = this.#buf.slice(emitLen);
				break;
			}

			// emit 事件之前的文本
			if (best.start > 0) {
				const emitText = this.#buf.slice(0, best.start);
				out += emitText;
				this.#updateLastNewline(emitText);
			}

			// 处理事件
			if (best.kind === "pair") {
				// 闭合对：整体吞掉
				this.#buf = this.#buf.slice(best.end);
				this.#lastEmittedEndedNewline = true;
			} else if (best.kind === "open") {
				// boundary 开标签：进入 block
				this.#buf = this.#buf.slice(best.end);
				this.#inBlock = true;
				this.#blockTagName = best.data.tagName;
				continue;
			} else {
				// orphan close：吞掉
				this.#buf = this.#buf.slice(best.end);
			}
		}
		return out;
	}

	#updateLastNewline(text: string): void {
		if (text.length === 0) return;
		const last = text[text.length - 1];
		// 跟踪任何空白字符（与 _is_block_boundary 的 index > 0 分支一致），
		// 使得跨 delta 时 index===0 的 boundary 判断能正确识别空格/Tab 后的标签。
		this.#lastEmittedEndedNewline =
			last === "\n" || last === "\r" || last === " " || last === "\t" || last === "\f" || last === "\v";
	}
}
