import { describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	DeveloperMessage,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import {
	applyAnthropicCacheControl,
	applyCacheMarker,
	buildCacheMarker,
	canCarryMarker,
	type CacheControlCarrier,
	type CacheMarker,
} from "@oh-my-pi/pi-ai/utils/prompt-caching";

// ────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────

function makeDeveloper(text: string): DeveloperMessage {
	return { role: "developer", content: text, timestamp: 0 };
}

function makeUserString(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeUserArray(parts: TextContent[]): UserMessage {
	return { role: "user", content: parts, timestamp: 0 };
}

function makeAssistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeAssistantToolCall(): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call-1",
		name: "test_tool",
		arguments: { arg: "value" },
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function makeToolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "test_tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function makeEmptyToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "test_tool",
		content: [],
		isError: false,
		timestamp: 0,
	};
}

/** 提取消息或其最后一个 content part 上的 cache_control 标记。 */
function getMarker(msg: Message): CacheMarker | undefined {
	const carrier = msg as Message & CacheControlCarrier;
	if (carrier.cache_control) return carrier.cache_control;
	if ("content" in msg && Array.isArray(msg.content) && msg.content.length > 0) {
		const last = msg.content[msg.content.length - 1] as CacheControlCarrier;
		return last?.cache_control;
	}
	return undefined;
}

/** 统计消息数组中携带 cache_control 标记的消息数。 */
function countMarkers(messages: Message[]): number {
	let count = 0;
	for (const msg of messages) {
		if (getMarker(msg)) count++;
	}
	return count;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("prompt-caching", () => {
	describe("buildCacheMarker", () => {
		it("5m 不写 ttl 字段", () => {
			const marker = buildCacheMarker("5m");
			expect(marker.type).toBe("ephemeral");
			expect(marker.ttl).toBeUndefined();
		});

		it("1h 写 ttl: '1h'", () => {
			const marker = buildCacheMarker("1h");
			expect(marker.type).toBe("ephemeral");
			expect(marker.ttl).toBe("1h");
		});
	});

	describe("canCarryMarker", () => {
		it("toolResult + native → true（即使 content 为空）", () => {
			expect(canCarryMarker(makeEmptyToolResult(), true)).toBe(true);
		});

		it("toolResult + 非 native + content 为空 → false", () => {
			expect(canCarryMarker(makeEmptyToolResult(), false)).toBe(false);
		});

		it("toolResult + 非 native + content 非空 → true", () => {
			expect(canCarryMarker(makeToolResult("result"), false)).toBe(true);
		});

		it("user string 非空 → true", () => {
			expect(canCarryMarker(makeUserString("hello"), true)).toBe(true);
		});

		it("user string 空 → false", () => {
			expect(canCarryMarker(makeUserString(""), true)).toBe(false);
		});

		it("user array 非空 → true", () => {
			expect(canCarryMarker(makeUserArray([{ type: "text", text: "hi" }]), false)).toBe(true);
		});

		it("assistant 非空 → true", () => {
			expect(canCarryMarker(makeAssistantText("hi"), true)).toBe(true);
		});

		it("assistant 纯 toolCall → true", () => {
			expect(canCarryMarker(makeAssistantToolCall(), true)).toBe(true);
		});
	});

	describe("applyCacheMarker — 4 种 content 形态 × 2 native", () => {
		const marker5m = buildCacheMarker("5m");
		const marker1h = buildCacheMarker("1h");

		it("toolResult + native → 顶层 cache_control", () => {
			const msg = makeToolResult("result");
			const marked = applyCacheMarker(msg, marker5m, true) as ToolResultMessage & CacheControlCarrier;
			expect(marked.cache_control).toEqual(marker5m);
			// content parts 不应被标记（native 用顶层）
			expect((marked.content[0] as CacheControlCarrier).cache_control).toBeUndefined();
		});

		it("toolResult + 非 native → 最后一个 part 标记", () => {
			const msg = makeToolResult("result");
			const marked = applyCacheMarker(msg, marker5m, false) as ToolResultMessage;
			expect((marked as unknown as CacheControlCarrier).cache_control).toBeUndefined();
			expect((marked.content[0] as CacheControlCarrier).cache_control).toEqual(marker5m);
		});

		it("toolResult + 非 native + content 空 → 跳过", () => {
			const msg = makeEmptyToolResult();
			const marked = applyCacheMarker(msg, marker5m, false) as ToolResultMessage;
			expect((marked as unknown as CacheControlCarrier).cache_control).toBeUndefined();
			expect(marked.content.length).toBe(0);
		});

		it("user string + native → 转为 array 并标记", () => {
			const msg = makeUserString("hello");
			const marked = applyCacheMarker(msg, marker5m, true) as UserMessage;
			expect(Array.isArray(marked.content)).toBe(true);
			const arr = marked.content as TextContent[];
			expect(arr.length).toBe(1);
			expect(arr[0].type).toBe("text");
			expect(arr[0].text).toBe("hello");
			expect((arr[0] as CacheControlCarrier).cache_control).toEqual(marker5m);
		});

		it("user string + 非 native → 同样转为 array 并标记", () => {
			const msg = makeUserString("world");
			const marked = applyCacheMarker(msg, marker1h, false) as UserMessage;
			const arr = marked.content as TextContent[];
			expect((arr[0] as CacheControlCarrier).cache_control).toEqual(marker1h);
		});

		it("user array + native → 最后一个 part 标记", () => {
			const msg = makeUserArray([
				{ type: "text", text: "part1" },
				{ type: "text", text: "part2" },
			]);
			const marked = applyCacheMarker(msg, marker5m, true) as UserMessage;
			const arr = marked.content as (TextContent & CacheControlCarrier)[];
			expect(arr[0].cache_control).toBeUndefined();
			expect(arr[1].cache_control).toEqual(marker5m);
		});

		it("user array + 非 native → 最后一个 part 标记", () => {
			const msg = makeUserArray([{ type: "text", text: "only" }]);
			const marked = applyCacheMarker(msg, marker5m, false) as UserMessage;
			const arr = marked.content as (TextContent & CacheControlCarrier)[];
			expect(arr[0].cache_control).toEqual(marker5m);
		});

		it("assistant + native → 最后一个 part 标记", () => {
			const msg = makeAssistantText("response");
			const marked = applyCacheMarker(msg, marker5m, true) as AssistantMessage;
			const last = marked.content[marked.content.length - 1] as unknown as CacheControlCarrier;
			expect(last.cache_control).toEqual(marker5m);
		});

		it("assistant + 非 native → 最后一个 part 标记", () => {
			const msg = makeAssistantText("response");
			const marked = applyCacheMarker(msg, marker1h, false) as AssistantMessage;
			const last = marked.content[marked.content.length - 1] as unknown as CacheControlCarrier;
			expect(last.cache_control).toEqual(marker1h);
		});

		it("assistant 纯 toolCall → 标记 toolCall block", () => {
			const msg = makeAssistantToolCall();
			const marked = applyCacheMarker(msg, marker5m, true) as AssistantMessage;
			const last = marked.content[marked.content.length - 1] as unknown as CacheControlCarrier;
			expect(last.cache_control).toEqual(marker5m);
		});
	});

	describe("applyAnthropicCacheControl — system_and_3 策略", () => {
		it("标记 1 个 developer + 最后 3 条非 developer = 4 个断点", () => {
			const messages: Message[] = [
				makeDeveloper("system prompt"),
				makeUserString("user1"),
				makeAssistantText("assistant1"),
				makeUserString("user2"),
				makeAssistantText("assistant2"),
				makeUserString("user3"),
			];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			expect(countMarkers(result)).toBe(4);
			// developer 被标记
			expect(getMarker(result[0]!)).toBeDefined();
			// 最后 3 条被标记
			expect(getMarker(result[3]!)).toBeDefined();
			expect(getMarker(result[4]!)).toBeDefined();
			expect(getMarker(result[5]!)).toBeDefined();
			// 中间的 user1, assistant1 不被标记
			expect(getMarker(result[1]!)).toBeUndefined();
			expect(getMarker(result[2]!)).toBeUndefined();
		});

		it("无 developer 时只标记最后 3 条", () => {
			const messages: Message[] = [
				makeUserString("user1"),
				makeAssistantText("assistant1"),
				makeUserString("user2"),
			];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			expect(countMarkers(result)).toBe(3);
		});

		it("消息少于 4 条时只标记存在的", () => {
			const messages: Message[] = [makeUserString("only message")];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			expect(countMarkers(result)).toBe(1);
		});

		it("空消息数组返回空数组", () => {
			const result = applyAnthropicCacheControl([], "5m", true);
			expect(result).toEqual([]);
		});

		it("toolResult 消息也可以被标记", () => {
			const messages: Message[] = [
				makeDeveloper("system"),
				makeAssistantToolCall(),
				makeToolResult("result"),
			];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			expect(countMarkers(result)).toBe(3);
		});

		it("非 native 时空 toolResult 不被标记（canCarryMarker false）", () => {
			const messages: Message[] = [
				makeDeveloper("system"),
				makeAssistantToolCall(),
				makeEmptyToolResult(),
			];
			const result = applyAnthropicCacheControl(messages, "5m", false);
			// developer 被标记（1），空 toolResult 不被标记，assistant 被标记
			// 最后 3 条非 developer: assistantToolCall, emptyToolResult
			// emptyToolResult canCarryMarker=false，所以只有 assistant 被标记
			expect(countMarkers(result)).toBe(2);
			expect(getMarker(result[0]!)).toBeDefined(); // developer
			expect(getMarker(result[2]!)).toBeUndefined(); // empty toolResult
		});
	});

	describe("深拷贝验证", () => {
		it("不修改原始消息数组", () => {
			const original: Message[] = [
				makeDeveloper("system"),
				makeUserString("user"),
				makeAssistantText("assistant"),
			];
			const originalSnapshot = JSON.parse(JSON.stringify(original));
			applyAnthropicCacheControl(original, "5m", true);
			expect(JSON.parse(JSON.stringify(original))).toEqual(originalSnapshot);
		});

		it("不修改原始消息对象", () => {
			const userMsg = makeUserString("hello");
			const original: Message[] = [userMsg];
			applyAnthropicCacheControl(original, "5m", true);
			// 原始消息的 content 仍然是 string
			expect(userMsg.content).toBe("hello");
		});

		it("返回的是新数组（不是原数组引用）", () => {
			const original: Message[] = [makeUserString("hello")];
			const result = applyAnthropicCacheControl(original, "5m", true);
			expect(result).not.toBe(original);
		});

		it("返回的消息对象是新对象（不是原对象引用）", () => {
			const userMsg = makeUserString("hello");
			const original: Message[] = [userMsg];
			const result = applyAnthropicCacheControl(original, "5m", true);
			expect(result[0]).not.toBe(userMsg);
		});

		it("user array content 的 part 也是深拷贝", () => {
			const part: TextContent = { type: "text", text: "original" };
			const userMsg = makeUserArray([part]);
			const original: Message[] = [userMsg];
			const result = applyAnthropicCacheControl(original, "5m", true);
			const markedPart = (result[0] as UserMessage).content as TextContent[];
			expect(markedPart[0]).not.toBe(part);
			expect(markedPart[0].text).toBe("original");
		});
	});

	describe("TTL 设置", () => {
		it("5m 时标记无 ttl 字段", () => {
			const messages: Message[] = [makeUserString("hello")];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			const marker = getMarker(result[0]!);
			expect(marker?.type).toBe("ephemeral");
			expect(marker?.ttl).toBeUndefined();
		});

		it("1h 时标记有 ttl: '1h'", () => {
			const messages: Message[] = [makeUserString("hello")];
			const result = applyAnthropicCacheControl(messages, "1h", true);
			const marker = getMarker(result[0]!);
			expect(marker?.type).toBe("ephemeral");
			expect(marker?.ttl).toBe("1h");
		});
	});

	describe("边界情况", () => {
		it("纯 toolCall assistant 被标记（有 content）", () => {
			const msg = makeAssistantToolCall();
			expect(canCarryMarker(msg, true)).toBe(true);
			const marked = applyCacheMarker(msg, buildCacheMarker("5m"), true);
			const last = (marked as AssistantMessage).content[0] as unknown as CacheControlCarrier;
			expect(last.cache_control).toBeDefined();
		});

		it("developer content 为 string 时转为 array 标记", () => {
			const messages: Message[] = [makeDeveloper("system instruction")];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			const dev = result[0] as DeveloperMessage;
			expect(Array.isArray(dev.content)).toBe(true);
			const arr = dev.content as (TextContent & CacheControlCarrier)[];
			expect(arr[0].cache_control).toBeDefined();
		});

		it("多条 developer 时只标记第一条", () => {
			const messages: Message[] = [
				makeDeveloper("first system"),
				makeDeveloper("second system"),
				makeUserString("user"),
			];
			const result = applyAnthropicCacheControl(messages, "5m", true);
			expect(getMarker(result[0]!)).toBeDefined();
			expect(getMarker(result[1]!)).toBeUndefined();
		});
	});
});
