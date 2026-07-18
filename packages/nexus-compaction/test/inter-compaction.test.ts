/**
 * inter-compaction 单测
 *
 * 覆盖：
 * - filterTurnsForInterCompaction：丢弃 system/tool，剥离 assistant toolCall 内容
 * - splitPriorCompactionText：剥离 <grok_user_queries> 块
 * - separatePriorUserQueries：分离 prior compaction 摘要
 * - truncateMiddle：中间截断
 * - extractUserQueriesFromTurns / assembleUserQueriesPreamble：组装前导块
 * - deduplicateCrossTurnContent：跨 turn 完全重复检测与 [ref:] 替换
 * - interCompaction：端到端
 */
import { describe, expect, test } from "bun:test";
import {
	type NexusMessage,
	type NexusCompactionConfig,
	DEFAULT_NEXUS_CONFIG,
} from "../src/types";
import {
	interCompaction,
	filterTurnsForInterCompaction,
	separatePriorUserQueries,
	splitPriorCompactionText,
	extractUserQueriesFromTurns,
	truncateMiddle,
	assembleUserQueriesPreamble,
	deduplicateCrossTurnContent,
} from "../src/inter-compaction";
import { estimateMessagesTokens } from "../src/tokenizer";

// ============================================================
// 测试夹具
// ============================================================

const config: NexusCompactionConfig = { ...DEFAULT_NEXUS_CONFIG, interThreshold: 64 };

function userMsg(text: string): NexusMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function assistantMsg(text: string): NexusMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
}
function assistantWithToolCall(): NexusMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I will run a tool." },
			{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } },
		],
		timestamp: 0,
	};
}
function systemMsg(text: string): NexusMessage {
	return { role: "system", content: text, timestamp: 0 };
}
function toolResultMsg(id: string): NexusMessage {
	return {
		role: "toolResult",
		content: "tool output",
		timestamp: 0,
		toolCallId: id,
	};
}
function compactionSummaryMsg(summary: string): NexusMessage {
	return { role: "compactionSummary", summary, content: summary, timestamp: 0 } as NexusMessage;
}

// ============================================================
// filterTurnsForInterCompaction
// ============================================================

describe("filterTurnsForInterCompaction", () => {
	test("丢弃 system 与 tool 消息", () => {
		const msgs: NexusMessage[] = [
			systemMsg("sys"),
			userMsg("hello"),
			assistantMsg("hi"),
			toolResultMsg("tc1"),
		];
		const out = filterTurnsForInterCompaction(msgs);
		expect(out.length).toBe(2);
		expect((out[0] as { role: string }).role).toBe("user");
		expect((out[1] as { role: string }).role).toBe("assistant");
	});

	test("剥离 assistant 的 toolCall 块，保留 text", () => {
		const out = filterTurnsForInterCompaction([assistantWithToolCall()]);
		expect(out.length).toBe(1);
		const content = (out[0] as { content: Array<{ type: string }> }).content;
		expect(content.length).toBe(1);
		expect(content[0].type).toBe("text");
	});

	test("全 toolCall 的 assistant 被丢弃", () => {
		const onlyToolCall: NexusMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "x", name: "n", arguments: {} }],
			timestamp: 0,
		};
		const out = filterTurnsForInterCompaction([onlyToolCall]);
		expect(out.length).toBe(0);
	});

	test("compactionSummary 保留（developer 角色）", () => {
		const out = filterTurnsForInterCompaction([compactionSummaryMsg("prev summary")]);
		expect(out.length).toBe(1);
	});
});

// ============================================================
// splitPriorCompactionText
// ============================================================

describe("splitPriorCompactionText", () => {
	test("分离 <grok_user_queries> 块与正文", () => {
		const text = `Some preamble
<grok_user_queries>
<grok_query>q1</grok_query>
</grok_user_queries>
Summary body here.`;
		const { userSection, rest } = splitPriorCompactionText(text);
		expect(userSection).toContain("<grok_user_queries>");
		expect(userSection).toContain("</grok_user_queries>");
		expect(rest).toContain("Some preamble");
		expect(rest).toContain("Summary body here.");
		expect(rest).not.toContain("<grok_user_queries>");
	});

	test("无块时全部归 rest", () => {
		const { userSection, rest } = splitPriorCompactionText("plain text");
		expect(userSection).toBeNull();
		expect(rest).toBe("plain text");
	});

	test("多个块全部抽出", () => {
		const text = `<grok_user_queries>q1</grok_user_queries> middle <grok_user_queries>q2</grok_user_queries>`;
		const { userSection, rest } = splitPriorCompactionText(text);
		expect(userSection).toContain("q1");
		expect(userSection).toContain("q2");
		expect(rest).toContain("middle");
	});
});

// ============================================================
// separatePriorUserQueries
// ============================================================

describe("separatePriorUserQueries", () => {
	test("从 compactionSummary 抽出 prior queries", () => {
		const summary = `<grok_user_queries>
<grok_query>old query</grok_query>
</grok_user_queries>
Actual summary text.`;
		const { turnsForLlm, priorUserQueries, hasPriorCompaction } = separatePriorUserQueries([
			userMsg("new"),
			compactionSummaryMsg(summary),
		]);
		expect(hasPriorCompaction).toBe(true);
		expect(priorUserQueries).toContain("<grok_query>old query</grok_query>");
		// rest（"Actual summary text."）保留在 turnsForLlm
		const summaryItem = turnsForLlm.find(m => (m as { role?: string }).role === "compactionSummary");
		expect(summaryItem).toBeTruthy();
		expect((summaryItem as { summary: string }).summary).toContain("Actual summary text.");
		expect((summaryItem as { summary: string }).summary).not.toContain("<grok_user_queries>");
	});

	test("非 summary 消息原样通过", () => {
		const { turnsForLlm, hasPriorCompaction } = separatePriorUserQueries([
			userMsg("a"),
			assistantMsg("b"),
		]);
		expect(hasPriorCompaction).toBe(false);
		expect(turnsForLlm.length).toBe(2);
	});
});

// ============================================================
// truncateMiddle
// ============================================================

describe("truncateMiddle", () => {
	test("短文本不截断", () => {
		expect(truncateMiddle("short", 100)).toBe("short");
	});

	test("长文本中间截断", () => {
		const long = "A".repeat(1000);
		const out = truncateMiddle(long, 100);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("...[truncated]...");
		// 首尾保留
		expect(out.startsWith("A".repeat(50))).toBe(true);
		expect(out.endsWith("A".repeat(50))).toBe(true);
	});
});

// ============================================================
// extractUserQueriesFromTurns / assembleUserQueriesPreamble
// ============================================================

describe("extractUserQueriesFromTurns", () => {
	test("组装 <grok_user_queries> 块", () => {
		const out = extractUserQueriesFromTurns(
			[userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
			1000,
		);
		expect(out).not.toBeNull();
		expect(out).toContain("<grok_user_queries>");
		expect(out).toContain("<grok_query>q1</grok_query>");
		expect(out).toContain("<grok_query>q2</grok_query>");
	});

	test("无 user 消息时返回 null", () => {
		expect(extractUserQueriesFromTurns([assistantMsg("a")], 1000)).toBeNull();
	});

	test("超长 user 消息被中间截断", () => {
		const long = "X".repeat(2000);
		const out = extractUserQueriesFromTurns([userMsg(long)], 100);
		expect(out).not.toBeNull();
		expect(out).toContain("...[truncated]...");
	});
});

describe("assembleUserQueriesPreamble", () => {
	test("prior 与 current 拼接", () => {
		const out = assembleUserQueriesPreamble("PRIOR", "CURRENT");
		expect(out).toContain("PRIOR");
		expect(out).toContain("CURRENT");
	});

	test("prior 为 null 时仅 current", () => {
		const out = assembleUserQueriesPreamble(null, "CURRENT");
		expect(out).toContain("CURRENT");
		expect(out).not.toContain("PRIOR");
	});
});

// ============================================================
// deduplicateCrossTurnContent
// ============================================================

describe("deduplicateCrossTurnContent", () => {
	test("完全重复的长消息用 [ref:] 替代", () => {
		const longText = "B".repeat(200);
		const msgs: NexusMessage[] = [
			userMsg(longText),
			assistantMsg("response1"),
			userMsg(longText), // 重复
		];
		const { messages, stats } = deduplicateCrossTurnContent(msgs, config.interThreshold);
		expect(stats.replacements).toBe(1);
		expect(stats.applied).toBe(true);
		// 第三条消息被替换
		const replaced = messages[2];
		const replacedText = (replaced as { content?: string }).content ?? "";
		expect(replacedText).toContain("[ref:");
		expect(replacedText).toContain("duplicated from turn #0");
	});

	test("短消息不参与去重", () => {
		const msgs: NexusMessage[] = [userMsg("short"), userMsg("short")];
		const { stats } = deduplicateCrossTurnContent(msgs, config.interThreshold);
		expect(stats.replacements).toBe(0);
		expect(stats.applied).toBe(false);
	});

	test("首次出现的重复源保留", () => {
		const longText = "C".repeat(200);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText)];
		const { messages } = deduplicateCrossTurnContent(msgs, config.interThreshold);
		// 第一条原样保留
		expect((messages[0] as { content?: string }).content).toBe(longText);
	});

	test("token 节省为正", () => {
		const longText = "D".repeat(500);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText)];
		const { stats } = deduplicateCrossTurnContent(msgs, config.interThreshold);
		expect(stats.tokensSaved).toBeGreaterThan(0);
	});
});

// ============================================================
// interCompaction（端到端）
// ============================================================

describe("interCompaction", () => {
	test("端到端：含重复长文本时触发压缩", () => {
		const longText = "E".repeat(300);
		const msgs: NexusMessage[] = [
			systemMsg("sys"), // 应被过滤
			userMsg(longText),
			assistantMsg("a1"),
			userMsg(longText), // 重复
			toolResultMsg("tc"), // 应被过滤
		];
		const { messages, stats } = interCompaction(msgs, config);
		expect(stats.applied).toBe(true);
		expect(stats.replacements).toBeGreaterThanOrEqual(1);
		// system 与 toolResult 已被过滤
		const roles = messages.map(m => (m as { role?: string }).role);
		expect(roles).not.toContain("system");
		expect(roles).not.toContain("toolResult");
	});

	test("无重复时 applied=false", () => {
		const msgs: NexusMessage[] = [
			userMsg("unique question one"),
			assistantMsg("unique answer one"),
		];
		const { stats } = interCompaction(msgs, config);
		expect(stats.applied).toBe(false);
	});

	test("不修改输入数组（返回新数组）", () => {
		const longText = "F".repeat(300);
		const original: NexusMessage[] = [userMsg(longText), userMsg(longText)];
		const originalTokens = estimateMessagesTokens(original);
		interCompaction(original, config);
		// 原数组未被修改
		expect(estimateMessagesTokens(original)).toBe(originalTokens);
		expect((original[1] as { content?: string }).content).toBe(longText);
	});
});
