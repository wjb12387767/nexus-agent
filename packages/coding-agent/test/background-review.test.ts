/**
 * A1 Background Review 单元测试。
 *
 * 覆盖：
 *  - digestHistory（tail 截断、role 交替边界）
 *  - summarizeBackgroundReviewActions（去重、verbose 预览、过滤失败）
 *  - buildMemoryWriteMetadata（过滤 None）
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import {
	buildMemoryWriteMetadata,
	digestHistory,
	summarizeBackgroundReviewActions,
	type BackgroundReviewSnapshot,
} from "../src/background-review";

// ═══════════════════════════════════════════════════════════════════════════
// 测试夹具构造
// ═══════════════════════════════════════════════════════════════════════════

function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		attribution: "user",
		timestamp: Date.now(),
	};
}

function makeAssistantMessage(text: string, toolCalls: ToolCall[] = []): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	for (const call of toolCalls) content.push(call);
	return {
		role: "assistant",
		content,
		api: "anthropic-messages" as never,
		provider: "anthropic" as never,
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as never,
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function makeToolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// digestHistory
// ═══════════════════════════════════════════════════════════════════════════

describe("digestHistory", () => {
	it("messages.length <= tail 时原样返回（副本）", () => {
		const messages: AgentMessage[] = [makeUserMessage("hello"), makeAssistantMessage("hi")];
		const result = digestHistory(messages, 24);
		expect(result.length).toBe(2);
		expect(result[0]).toBe(messages[0]);
		expect(result[1]).toBe(messages[1]);
	});

	it("messages.length > tail 时折叠为 digest + tail", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push(makeUserMessage(`user message ${i}`));
			messages.push(makeAssistantMessage(`assistant reply ${i}`));
		}
		const tail = 5;
		const result = digestHistory(messages, tail);
		// 1 条 digest + tail 条原始消息
		expect(result.length).toBe(tail + 1);
		// 第一条是 digest（user 角色）
		expect(result[0].role).toBe("user");
		const digestContent = (result[0] as UserMessage).content;
		expect(typeof digestContent).toBe("string");
		expect(digestContent as string).toContain("[digest of prior conversation]");
		// 尾部保留最后 tail 条原始消息
		const tailOriginal = messages.slice(messages.length - tail);
		for (let i = 0; i < tail; i++) {
			expect(result[i + 1]).toBe(tailOriginal[i]);
		}
	});

	it("digest 文本中 USER 取前 300 字符", () => {
		const longText = "A".repeat(500);
		const messages: AgentMessage[] = [makeUserMessage(longText)];
		// 加足够的消息让 digest 触发
		for (let i = 0; i < 5; i++) messages.push(makeAssistantMessage(`reply ${i}`));
		const result = digestHistory(messages, 2);
		const digest = result[0] as UserMessage;
		const digestText = digest.content as string;
		// USER 行包含截断后的文本（300 字符 + 省略号）
		expect(digestText).toContain("USER:");
		const userLine = digestText.split("\n").find(l => l.startsWith("USER:"));
		expect(userLine).toBeDefined();
		// 截断后约 300 字符（"USER: " 前缀 + 299 字符 + "…"）
		expect(userLine!.length).toBeLessThan(longText.length);
	});

	it("digest 文本中 ASSISTANT 取前 200 字符并附带 tools 后缀", () => {
		const longText = "B".repeat(400);
		const call = makeToolCall("c1", "memory", { action: "create" });
		const messages: AgentMessage[] = [
			makeAssistantMessage(longText, [call]),
			makeUserMessage("tail msg 1"),
			makeUserMessage("tail msg 2"),
		];
		const result = digestHistory(messages, 2);
		const digest = result[0] as UserMessage;
		const digestText = digest.content as string;
		expect(digestText).toContain("ASSISTANT:");
		const assistantLine = digestText.split("\n").find(l => l.startsWith("ASSISTANT:"));
		expect(assistantLine).toBeDefined();
		// 应包含 tools 后缀
		expect(assistantLine!).toContain("[tools: memory]");
		// 截断后不超过 200 字符 + 前缀 + 后缀
		expect(assistantLine!.length).toBeLessThan(longText.length);
	});

	it("role 交替边界：user/assistant/user/assistant 序列正确折叠", () => {
		const messages: AgentMessage[] = [
			makeUserMessage("first user"),
			makeAssistantMessage("first assistant"),
			makeUserMessage("second user"),
			makeAssistantMessage("second assistant"),
			// tail 部分
			makeUserMessage("tail user 1"),
			makeAssistantMessage("tail assistant 1"),
		];
		const result = digestHistory(messages, 2);
		expect(result.length).toBe(3); // 1 digest + 2 tail
		// digest 应包含 4 条 older 消息的摘要
		const digestText = (result[0] as UserMessage).content as string;
		expect(digestText).toContain("first user");
		expect(digestText).toContain("first assistant");
		expect(digestText).toContain("second user");
		expect(digestText).toContain("second assistant");
		// tail 保留最后 2 条
		expect(result[1].role).toBe("user");
		expect(result[2].role).toBe("assistant");
	});

	it("TOOL_RESULT 消息在 digest 中正确折叠", () => {
		const messages: AgentMessage[] = [
			makeUserMessage("query"),
			makeAssistantMessage("calling tool", [makeToolCall("t1", "memory")]),
			makeToolResult("t1", "memory", "result text"),
			// tail
			makeUserMessage("tail"),
		];
		const result = digestHistory(messages, 1);
		const digestText = (result[0] as UserMessage).content as string;
		expect(digestText).toContain("TOOL_RESULT(memory)");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// summarizeBackgroundReviewActions
// ═══════════════════════════════════════════════════════════════════════════

describe("summarizeBackgroundReviewActions", () => {
	const emptySnapshot: BackgroundReviewSnapshot = { skills: [], memories: [] };

	it("mode=off 时返回空字符串", () => {
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [makeToolCall("c1", "memory", { action: "create", name: "pref" })]),
			makeToolResult("c1", "memory", "saved"),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "off");
		expect(result).toBe("");
	});

	it("去重：相同动作只出现一次", () => {
		const call = makeToolCall("c1", "memory", { action: "create", name: "pref" });
		// 两条 assistant 消息都带相同的 tool call（相同 id → 相同动作描述）
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [call]),
			makeToolResult("c1", "memory", "saved"),
			makeAssistantMessage("", [call]),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "on");
		// "memory created: pref" 只出现一次
		expect(result).toBe("memory created: pref");
	});

	it("过滤失败：isError=true 的 tool result 被跳过", () => {
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [
				makeToolCall("ok", "memory", { action: "create", name: "good" }),
				makeToolCall("fail", "memory", { action: "create", name: "bad" }),
			]),
			makeToolResult("ok", "memory", "saved", false),
			makeToolResult("fail", "memory", "error occurred", true),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "on");
		expect(result).toContain("memory created: good");
		expect(result).not.toContain("bad");
	});

	it("verbose 模式带预览（max 120 字符）", () => {
		const longPreview = "X".repeat(200);
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [makeToolCall("c1", "memory", { action: "create", name: "pref" })]),
			makeToolResult("c1", "memory", longPreview),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "verbose");
		expect(result).toContain("memory created: pref");
		expect(result).toContain("—");
		// 预览被截断（不超过 120 字符的预览 + 省略号）
		const previewPart = result.split("— ")[1] ?? "";
		expect(previewPart.length).toBeLessThanOrEqual(120);
	});

	it("verbose 模式标注已存在的目标 (existing)", () => {
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [makeToolCall("c1", "memory", { action: "create", name: "existing-mem" })]),
			makeToolResult("c1", "memory", "saved"),
		];
		const snapshot: BackgroundReviewSnapshot = { skills: [], memories: ["existing-mem"] };
		const result = summarizeBackgroundReviewActions(messages, snapshot, "verbose");
		expect(result).toContain("(existing)");
	});

	it("非白名单工具被跳过", () => {
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [makeToolCall("c1", "bash", { action: "create", name: "script" })]),
			makeToolResult("c1", "bash", "done"),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "on");
		expect(result).toBe("");
	});

	it("skill_manage 动作被正确识别", () => {
		const messages: AgentMessage[] = [
			makeAssistantMessage("", [makeToolCall("c1", "skill_manage", { action: "update", name: "my-skill" })]),
			makeToolResult("c1", "skill_manage", "updated"),
		];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "on");
		expect(result).toBe("skill updated: my-skill");
	});

	it("无 tool call 时返回空字符串", () => {
		const messages: AgentMessage[] = [makeAssistantMessage("no tools here")];
		const result = summarizeBackgroundReviewActions(messages, emptySnapshot, "on");
		expect(result).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// buildMemoryWriteMetadata
// ═══════════════════════════════════════════════════════════════════════════

describe("buildMemoryWriteMetadata", () => {
	it("始终包含 writtenAt", () => {
		const meta = buildMemoryWriteMetadata(undefined, undefined, undefined, undefined);
		expect(meta.writtenAt).toBeDefined();
		expect(typeof meta.writtenAt).toBe("string");
		// 应为 ISO 时间戳
		expect(() => new Date(meta.writtenAt)).not.toThrow();
	});

	it("过滤 None / undefined / 空字符串", () => {
		const meta = buildMemoryWriteMetadata("", undefined, undefined as never, "");
		expect(Object.keys(meta)).toEqual(["writtenAt"]);
	});

	it("提供所有字段时全部包含", () => {
		const meta = buildMemoryWriteMetadata("sess-1", "parent-1", "darwin", "memory");
		expect(meta.sessionId).toBe("sess-1");
		expect(meta.parentSessionId).toBe("parent-1");
		expect(meta.platform).toBe("darwin");
		expect(meta.toolName).toBe("memory");
		expect(meta.writtenAt).toBeDefined();
	});

	it("部分提供时只包含非空字段", () => {
		const meta = buildMemoryWriteMetadata("sess-2", undefined, "win32", undefined);
		expect(meta.sessionId).toBe("sess-2");
		expect(meta.platform).toBe("win32");
		expect(meta.parentSessionId).toBeUndefined();
		expect(meta.toolName).toBeUndefined();
		expect(meta.writtenAt).toBeDefined();
	});

	it("null 值被过滤", () => {
		const meta = buildMemoryWriteMetadata(null as never, null as never, null as never, null as never);
		expect(Object.keys(meta)).toEqual(["writtenAt"]);
	});
});
