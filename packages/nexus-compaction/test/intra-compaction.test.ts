/**
 * intra-compaction 单测
 *
 * 覆盖：
 * - mergeDuplicateBlocks：同消息内重复 text block 合并
 * - collapseThinkingBlocks：超长 thinking 块首尾保留 + 中间省略
 * - mergeAdjacentDuplicateMessages：相邻同 role 重复消息合并
 * - intraCompaction：端到端
 */
import { describe, expect, test } from "bun:test";
import {
	type NexusMessage,
	type NexusCompactionConfig,
	type ContentBlock,
	DEFAULT_NEXUS_CONFIG,
} from "../src/types";
import {
	intraCompaction,
	mergeDuplicateBlocks,
	collapseThinkingBlocks,
	mergeAdjacentDuplicateMessages,
} from "../src/intra-compaction";

// ============================================================
// 测试夹具
// ============================================================

const config: NexusCompactionConfig = { ...DEFAULT_NEXUS_CONFIG, intraThreshold: 64 };

function userMsg(text: string): NexusMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function userMsgBlocks(blocks: ContentBlock[]): NexusMessage {
	return { role: "user", content: blocks, timestamp: 0 };
}
function assistantMsgBlocks(blocks: ContentBlock[]): NexusMessage {
	return { role: "assistant", content: blocks, timestamp: 0 };
}
function textBlock(text: string): ContentBlock {
	return { type: "text", text };
}
function thinkingBlock(thinking: string): ContentBlock {
	return { type: "thinking", thinking };
}

// ============================================================
// mergeDuplicateBlocks
// ============================================================

describe("mergeDuplicateBlocks", () => {
	test("同消息内重复长 text block 合并", () => {
		const longText = "X".repeat(200);
		const msg = userMsgBlocks([textBlock(longText), textBlock(longText), textBlock("short")]);
		const { message, merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		expect(merged).toBe(1);
		const content = (message as { content: ContentBlock[] }).content;
		expect(content.length).toBe(2); // 1 个去重后的长 block + 1 个 short
	});

	test("短 block 不参与去重", () => {
		const msg = userMsgBlocks([textBlock("a"), textBlock("a"), textBlock("a")]);
		const { merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		expect(merged).toBe(0);
	});

	test("非 text block 原样保留", () => {
		const longText = "Y".repeat(200);
		const msg = assistantMsgBlocks([
			thinkingBlock(longText),
			textBlock(longText),
			textBlock(longText),
		]);
		const { message, merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		expect(merged).toBe(1);
		const content = (message as { content: ContentBlock[] }).content;
		// thinking 保留 + 1 个 text
		expect(content.length).toBe(2);
		expect(content[0].type).toBe("thinking");
	});

	test("无重复时 merged=0", () => {
		const msg = userMsgBlocks([textBlock("unique 1"), textBlock("unique 2")]);
		const { merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		expect(merged).toBe(0);
	});

	test("string content 不处理", () => {
		const msg = userMsg("plain string");
		const { message, merged } = mergeDuplicateBlocks(msg, config.intraThreshold);
		expect(merged).toBe(0);
		expect((message as { content: string }).content).toBe("plain string");
	});
});

// ============================================================
// collapseThinkingBlocks
// ============================================================

describe("collapseThinkingBlocks", () => {
	test("超长 thinking 块折叠为首尾 + 省略占位", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `thought line ${i}`);
		const thinking = lines.join("\n");
		const msg = assistantMsgBlocks([thinkingBlock(thinking)]);
		const { message, collapsed } = collapseThinkingBlocks(msg, 8);
		expect(collapsed).toBe(1);
		const content = (message as { content: ContentBlock[] }).content;
		const newThinking = (content[0] as { thinking: string }).thinking;
		expect(newThinking).toContain("lines elided");
		// 行数显著减少
		expect(newThinking.split("\n").length).toBeLessThan(lines.length);
	});

	test("短 thinking 块不折叠", () => {
		const thinking = "short\nthinking";
		const msg = assistantMsgBlocks([thinkingBlock(thinking)]);
		const { collapsed } = collapseThinkingBlocks(msg, 8);
		expect(collapsed).toBe(0);
	});

	test("默认 maxLines=8", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		const msg = assistantMsgBlocks([thinkingBlock(lines.join("\n"))]);
		const { collapsed } = collapseThinkingBlocks(msg);
		expect(collapsed).toBe(1);
	});

	test("无 thinking 块时 collapsed=0", () => {
		const msg = assistantMsgBlocks([textBlock("just text")]);
		const { collapsed } = collapseThinkingBlocks(msg);
		expect(collapsed).toBe(0);
	});
});

// ============================================================
// mergeAdjacentDuplicateMessages
// ============================================================

describe("mergeAdjacentDuplicateMessages", () => {
	test("相邻同 role 完全重复的长消息合并", () => {
		const longText = "Z".repeat(200);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText), userMsg("unique")];
		const { messages, merged } = mergeAdjacentDuplicateMessages(msgs, config.intraThreshold);
		expect(merged).toBe(1);
		expect(messages.length).toBe(2);
	});

	test("不同 role 不合并", () => {
		const longText = "A".repeat(200);
		const msgs: NexusMessage[] = [
			userMsg(longText),
			{ role: "assistant", content: [{ type: "text", text: longText }], timestamp: 0 },
		];
		const { merged } = mergeAdjacentDuplicateMessages(msgs, config.intraThreshold);
		expect(merged).toBe(0);
	});

	test("非相邻不合并", () => {
		const longText = "B".repeat(200);
		const msgs: NexusMessage[] = [
			userMsg(longText),
			userMsg("different long text ".repeat(20)),
			userMsg(longText),
		];
		const { merged } = mergeAdjacentDuplicateMessages(msgs, config.intraThreshold);
		expect(merged).toBe(0);
	});

	test("短消息不参与合并", () => {
		const msgs: NexusMessage[] = [userMsg("short"), userMsg("short")];
		const { merged } = mergeAdjacentDuplicateMessages(msgs, config.intraThreshold);
		expect(merged).toBe(0);
	});
});

// ============================================================
// intraCompaction（端到端）
// ============================================================

describe("intraCompaction", () => {
	test("端到端：重复 block + 长 thinking 触发压缩", () => {
		const longText = "C".repeat(200);
		const thinkingLines = Array.from({ length: 20 }, (_, i) => `t${i}`);
		const msgs: NexusMessage[] = [
			assistantMsgBlocks([
				textBlock(longText),
				textBlock(longText), // 重复
				thinkingBlock(thinkingLines.join("\n")), // 长 thinking
			]),
			userMsg(longText),
			userMsg(longText), // 相邻重复
		];
		const { messages, stats } = intraCompaction(msgs, config);
		expect(stats.applied).toBe(true);
		expect(stats.blocksMerged).toBeGreaterThanOrEqual(1);
		expect(stats.thinkingCollapsed).toBeGreaterThanOrEqual(1);
		// 消息数应减少（相邻重复合并）
		expect(messages.length).toBeLessThan(msgs.length);
	});

	test("无重复内容时 applied=false", () => {
		const msgs: NexusMessage[] = [
			userMsg("unique short 1"),
			{ role: "assistant", content: [{ type: "text", text: "unique short 2" }], timestamp: 0 },
		];
		const { stats } = intraCompaction(msgs, config);
		expect(stats.applied).toBe(false);
	});

	test("token 节省为正（含 thinking 折叠）", () => {
		const thinkingLines = Array.from({ length: 30 }, (_, i) => `thought ${i}`);
		const msgs: NexusMessage[] = [
			assistantMsgBlocks([thinkingBlock(thinkingLines.join("\n"))]),
		];
		const { stats } = intraCompaction(msgs, config);
		expect(stats.thinkingCollapsed).toBe(1);
		expect(stats.tokensSaved).toBeGreaterThan(0);
	});

	test("不修改输入数组", () => {
		const longText = "D".repeat(200);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText)];
		const originalLen = msgs.length;
		intraCompaction(msgs, config);
		expect(msgs.length).toBe(originalLen);
		expect((msgs[0] as { content: string }).content).toBe(longText);
	});
});
