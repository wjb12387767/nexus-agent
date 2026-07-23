/**
 * context-breakdown 模块单测：验证 8 类分类、char/4 估算、CSS 变量颜色与
 * 上下文百分比计算。
 */
import { describe, expect, test } from "bun:test";
import {
	_charsToTokens,
	_jsonTokens,
	computeContextBreakdown,
	estimateMessagesTokensRough,
	type AgentLike,
} from "../src/context-breakdown";
import { createAssistantMessage, createUserMessage } from "./helpers";

describe("_charsToTokens", () => {
	test("空字符串返回 0", () => {
		expect(_charsToTokens("")).toBe(0);
	});

	test("char/4 估算（向下取整）", () => {
		// (8 + 3) / 4 = 2.75 → 2
		expect(_charsToTokens("abcdefgh")).toBe(2);
		// (4 + 3) / 4 = 1.75 → 1
		expect(_charsToTokens("abcd")).toBe(1);
		// (1 + 3) / 4 = 1
		expect(_charsToTokens("a")).toBe(1);
	});
});

describe("_jsonTokens", () => {
	test("对象序列化后估算", () => {
		const tokens = _jsonTokens({ name: "read" });
		expect(tokens).toBeGreaterThan(0);
	});

	test("循环引用回退为 0", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(_jsonTokens(cyclic)).toBe(0);
	});
});

describe("estimateMessagesTokensRough", () => {
	test("累加 user 与 assistant 消息", () => {
		const messages = [
			createUserMessage("hello world"),
			createAssistantMessage([{ type: "text", text: "hi there" }]),
		];
		const tokens = estimateMessagesTokensRough(messages);
		// "hello world" = 11 chars → 3 tokens；"hi there" = 8 chars → 2 tokens
		expect(tokens).toBe(_charsToTokens("hello world") + _charsToTokens("hi there"));
	});

	test("空消息列表返回 0", () => {
		expect(estimateMessagesTokensRough([])).toBe(0);
	});
});

describe("computeContextBreakdown", () => {
	test("返回 8 类分类且顺序固定", () => {
		const agent: AgentLike = { model: "test/model", contextWindow: 100000 };
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.categories).toHaveLength(8);
		expect(breakdown.categories.map(c => c.id)).toEqual([
			"system_prompt",
			"tool_definitions",
			"rules",
			"skills",
			"mcp",
			"subagent_definitions",
			"memory",
			"conversation",
		]);
	});

	test("每类附带 CSS 变量颜色", () => {
		const agent: AgentLike = { model: "test/model", contextWindow: 100000 };
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.categories[0].color).toBe("var(--context-usage-system)");
		expect(breakdown.categories[1].color).toBe("var(--context-usage-tools)");
		expect(breakdown.categories[7].color).toBe("var(--context-usage-conversation)");
	});

	test("system_prompt 估算正确", () => {
		const prompt = "a".repeat(40);
		const agent: AgentLike = { model: "test/model", contextWindow: 100000, systemPrompt: prompt };
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.categories[0].tokens).toBe(_charsToTokens(prompt));
	});

	test("tool_definitions 估算累加所有工具", () => {
		const tools = [
			{ name: "read", description: "read a file" },
			{ name: "write", description: "write a file" },
		];
		const agent: AgentLike = { model: "test/model", contextWindow: 100000, tools };
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.categories[1].tokens).toBe(_jsonTokens(tools[0]) + _jsonTokens(tools[1]));
	});

	test("conversation 估算来自消息列表", () => {
		const messages = [createUserMessage("hello world")];
		const agent: AgentLike = { model: "test/model", contextWindow: 100000 };
		const breakdown = computeContextBreakdown(agent, messages);
		expect(breakdown.categories[7].tokens).toBe(_charsToTokens("hello world"));
	});

	test("context_used 等于各类 token 之和", () => {
		const agent: AgentLike = {
			model: "test/model",
			contextWindow: 100000,
			systemPrompt: "system",
			tools: [{ name: "read" }],
			memory: "some memory",
		};
		const messages = [createUserMessage("hi")];
		const breakdown = computeContextBreakdown(agent, messages);
		const sum = breakdown.categories.reduce((acc, c) => acc + c.tokens, 0);
		expect(breakdown.context_used).toBe(sum);
		expect(breakdown.estimated_total).toBe(sum);
	});

	test("context_percent 基于上下文窗口", () => {
		const agent: AgentLike = {
			model: "test/model",
			contextWindow: 100,
			systemPrompt: "a".repeat(40), // 10 tokens
		};
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.context_percent).toBeCloseTo(10, 1);
	});

	test("无上下文窗口时 context_percent 为 0", () => {
		const agent: AgentLike = { model: "test/model", systemPrompt: "a".repeat(40) };
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.context_percent).toBe(0);
		expect(breakdown.context_max).toBe(0);
	});

	test("model 默认为 unknown", () => {
		const breakdown = computeContextBreakdown({}, []);
		expect(breakdown.model).toBe("unknown");
	});

	test("skills 与 mcp 分类独立计算", () => {
		const agent: AgentLike = {
			model: "test/model",
			contextWindow: 100000,
			skills: [{ name: "deploy", description: "deploy app" }],
			mcpTools: [{ name: "mcp_tool", description: "mcp tool" }],
		};
		const breakdown = computeContextBreakdown(agent, []);
		expect(breakdown.categories[3].tokens).toBe(_jsonTokens({ name: "deploy", description: "deploy app" }));
		expect(breakdown.categories[4].tokens).toBe(_jsonTokens({ name: "mcp_tool", description: "mcp tool" }));
	});
});
