/**
 * Anthropic prompt caching 断点标记工具（hermes 风格）。
 *
 * 在 {@link Message} 层面为消息添加 `cache_control` 断点，供 Anthropic 兼容
 * provider 在转换为 wire 格式时读取。纯函数，深拷贝输入，不修改原始数组。
 *
 * 策略 `system_and_3`：1 个 system/developer 消息 + 最后 3 条非 system 消息，
 * 共 4 个断点（Anthropic 单次请求上限）。
 */

import type {
	AssistantMessage,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../types";

/** 缓存生存时间。`"5m"` 为默认（不写 ttl 字段），`"1h"` 显式标记。 */
export type CacheTtl = "5m" | "1h";

/** Anthropic `cache_control` 标记。5m 默认不写 `ttl`，1h 写 `"1h"`。 */
export interface CacheMarker {
	type: "ephemeral";
	ttl?: "1h";
}

/**
 * 可携带 `cache_control` 标记的载体。content part 或消息顶层实现此接口后，
 * provider 可通过 `(block as CacheControlCarrier).cache_control` 读取标记。
 */
export interface CacheControlCarrier {
	cache_control?: CacheMarker;
}

/** Anthropic 单次请求的 cache_control 断点上限。 */
const MAX_CACHE_BREAKPOINTS = 4;

/** `system_and_3` 策略中，非 system 消息的尾部断点数。 */
const TAIL_BREAKPOINT_COUNT = 3;

/**
 * 构造 cache_control 标记。`"5m"` 是 Anthropic 默认值，不写 `ttl` 字段；
 * `"1h"` 显式写入 `ttl: "1h"`。
 */
export function buildCacheMarker(ttl: CacheTtl): CacheMarker {
	return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * 判断消息能否携带 cache_control 标记。
 *
 * - `toolResult` 角色：native Anthropic 时总是可以（顶层 marker）；非 native
 *   时需要 content 非空（OpenRouter 拒绝空 tool 顶层 marker）。
 * - `user`/`developer` 角色：content 非空时可以。
 * - `assistant` 角色：content 非空时可以。
 */
export function canCarryMarker(msg: Message, nativeAnthropic: boolean): boolean {
	switch (msg.role) {
		case "toolResult":
			if (nativeAnthropic) return true;
			return msg.content.length > 0;
		case "user":
		case "developer": {
			const content = msg.content;
			if (typeof content === "string") return content.length > 0;
			return content.length > 0;
		}
		case "assistant":
			return msg.content.length > 0;
		default:
			return false;
	}
}

/**
 * 给单条消息（深拷贝）添加 cache_control 标记。根据消息格式分支处理：
 *
 * - `toolResult` + nativeAnthropic → 顶层 `cache_control`
 * - `toolResult` + 非 native + content 为空 → 跳过（OpenRouter 拒绝空 tool 顶层 marker）
 * - content 为 string → 转为 `[{type:"text", text, cache_control}]`
 * - content 为 array → 标在最后一个 part
 *
 * 不修改原始消息；返回深拷贝。
 */
export function applyCacheMarker(
	msg: Message,
	marker: CacheMarker,
	nativeAnthropic: boolean,
): Message {
	const clone = structuredClone(msg) as Message & CacheControlCarrier;

	if (clone.role === "toolResult") {
		const toolMsg = clone as ToolResultMessage & CacheControlCarrier;
		if (nativeAnthropic) {
			// native Anthropic：顶层 cache_control
			toolMsg.cache_control = marker;
			return clone;
		}
		// 非 native：content 为空时跳过（OpenRouter 拒绝空 tool 顶层 marker）
		if (toolMsg.content.length === 0) return clone;
		// 标在最后一个 part
		const last = toolMsg.content[toolMsg.content.length - 1] as (TextContent | ImageContent) & CacheControlCarrier;
		last.cache_control = marker;
		return clone;
	}

	// user / developer：content 可能是 string 或 array
	if (clone.role === "user" || clone.role === "developer") {
		const userMsg = clone as UserMessage & CacheControlCarrier;
		if (typeof userMsg.content === "string") {
			// content 为 string → 转为 [{type:"text", text, cache_control}]
			if (userMsg.content.length === 0) return clone;
			const textBlock: TextContent & CacheControlCarrier = {
				type: "text",
				text: userMsg.content,
				cache_control: marker,
			};
			// 保留 textSignature 等扩展字段（如有）
			userMsg.content = [textBlock];
			return clone;
		}
		// content 为 array → 标在最后一个 part
		if (userMsg.content.length > 0) {
			const last = userMsg.content[userMsg.content.length - 1] as (TextContent | ImageContent) & CacheControlCarrier;
			last.cache_control = marker;
		}
		return clone;
	}

	// assistant：content 为 array，标在最后一个 part
	if (clone.role === "assistant") {
		const assistantMsg = clone as AssistantMessage & CacheControlCarrier;
		if (assistantMsg.content.length > 0) {
			const last = assistantMsg.content[assistantMsg.content.length - 1] as unknown as CacheControlCarrier;
			last.cache_control = marker;
		}
		return clone;
	}

	return clone;
}

/**
 * 对消息数组应用 `system_and_3` 缓存策略：1 个 system/developer 消息 + 最后 3 条
 * 非 system 消息，共 4 个 cache_control 断点。
 *
 * 纯函数：深拷贝输入消息，不修改原始数组。仅标记能携带 marker 的消息
 * （见 {@link canCarryMarker}）。
 *
 * @param messages 输入消息数组
 * @param cacheTtl 缓存生存时间
 * @param nativeAnthropic 是否为原生 Anthropic 端点（影响 toolResult 处理）
 * @returns 深拷贝并标记后的新消息数组
 */
export function applyAnthropicCacheControl(
	messages: readonly Message[],
	cacheTtl: CacheTtl,
	nativeAnthropic: boolean,
): Message[] {
	const marker = buildCacheMarker(cacheTtl);

	// 计算需要标记的消息索引（system_and_3 策略）
	const targetIndices = new Set<number>();
	let breakpointsUsed = 0;

	// 1. 第一个 developer 消息视为 system，标记 1 个断点
	for (let i = 0; i < messages.length; i++) {
		if (breakpointsUsed >= MAX_CACHE_BREAKPOINTS) break;
		const msg = messages[i];
		if (msg?.role === "developer" && canCarryMarker(msg, nativeAnthropic)) {
			targetIndices.add(i);
			breakpointsUsed++;
			break;
		}
	}

	// 2. 最后 3 条非 developer 消息，各标记 1 个断点
	const tailCandidates: number[] = [];
	for (let i = messages.length - 1; i >= 0 && tailCandidates.length < TAIL_BREAKPOINT_COUNT; i--) {
		const msg = messages[i];
		if (msg && msg.role !== "developer") {
			tailCandidates.push(i);
		}
	}
	// 从前往后标记（保持断点顺序）
	for (let j = tailCandidates.length - 1; j >= 0; j--) {
		if (breakpointsUsed >= MAX_CACHE_BREAKPOINTS) break;
		const idx = tailCandidates[j];
		if (idx === undefined) continue;
		const msg = messages[idx];
		if (msg && canCarryMarker(msg, nativeAnthropic)) {
			targetIndices.add(idx);
			breakpointsUsed++;
		}
	}

	// 深拷贝所有消息，对目标消息应用 marker
	return messages.map((msg, i) =>
		targetIndices.has(i) ? applyCacheMarker(msg, marker, nativeAnthropic) : structuredClone(msg),
	);
}
