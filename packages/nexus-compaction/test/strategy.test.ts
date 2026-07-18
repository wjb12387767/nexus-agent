/**
 * strategy 调度器单测
 *
 * 覆盖：
 * - resolveConfig：合并默认配置
 * - compact（omp 策略）：未注入 omp 函数 → passthrough；注入 → 委托
 * - compact（nexus 策略）：四级算法依次执行
 * - compact（hybrid 策略）：未注入 omp → 退化为 nexus；注入 → 两阶段
 * - 配置 strategy 字段切换路径
 * - 历史触发条件（turn 数 > historyTurns）
 */
import { describe, expect, test } from "bun:test";
import {
	type NexusMessage,
	type CompactionSampler,
	type OmpCompactionFn,
	DEFAULT_NEXUS_CONFIG,
} from "../src/types";
import { compact, resolveConfig } from "../src/strategy";
import { estimateMessagesTokens } from "../src/tokenizer";

// ============================================================
// 测试夹具
// ============================================================

function userMsg(text: string): NexusMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function assistantMsg(text: string): NexusMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
}
function systemMsg(text: string): NexusMessage {
	return { role: "system", content: text, timestamp: 0 };
}

/** 构造 100-turn 会话，每 turn 含 user + assistant，文本有重复内容 */
function build100TurnSession(): NexusMessage[] {
	const msgs: NexusMessage[] = [systemMsg("You are a helpful assistant.".repeat(20))];
	const longContext = "Project context: ".repeat(50); // 重复上下文
	for (let i = 0; i < 100; i++) {
		msgs.push(userMsg(`Turn ${i}: ${longContext} Please help with task ${i}.`));
		msgs.push(
			assistantMsg(
				`Response ${i}: ${longContext} Here is the solution with code:\n\`\`\`ts\nfunction solve${i}(x: number): number {\n${Array.from(
					{ length: 50 },
					(_, j) => `  const v${j} = ${j};`,
				).join("\n")}\n  return x;\n}\n\`\`\``,
			),
		);
	}
	return msgs;
}

// ============================================================
// resolveConfig
// ============================================================

describe("resolveConfig", () => {
	test("无参数返回默认配置", () => {
		const cfg = resolveConfig();
		expect(cfg.strategy).toBe(DEFAULT_NEXUS_CONFIG.strategy);
		expect(cfg.historyTurns).toBe(DEFAULT_NEXUS_CONFIG.historyTurns);
	});

	test("部分覆盖：仅覆盖指定字段", () => {
		const cfg = resolveConfig({ historyTurns: 50, strategy: "hybrid" });
		expect(cfg.historyTurns).toBe(50);
		expect(cfg.strategy).toBe("hybrid");
		// 未覆盖的字段保持默认
		expect(cfg.interThreshold).toBe(DEFAULT_NEXUS_CONFIG.interThreshold);
		expect(cfg.codeBlockSize).toBe(DEFAULT_NEXUS_CONFIG.codeBlockSize);
	});

	test("空对象视为无覆盖", () => {
		const cfg = resolveConfig({});
		expect(cfg.strategy).toBe(DEFAULT_NEXUS_CONFIG.strategy);
	});
});

// ============================================================
// compact —— omp 策略
// ============================================================

describe("compact —— omp 策略", () => {
	test("未注入 ompCompaction → passthrough（向后兼容）", async () => {
		const msgs: NexusMessage[] = [userMsg("hi"), assistantMsg("hello")];
		const result = await compact(msgs, { config: { strategy: "omp" } });
		expect(result.strategy).toBe("omp");
		expect(result.turnsCompacted).toBe(0);
		expect(result.tokensBefore).toBe(result.tokensAfter);
		expect(result.messages).toBe(msgs); // 同一引用，未修改
		expect(result.stages).toEqual({
			inter: false,
			intra: false,
			code: false,
			history: false,
		});
	});

	test("注入 ompCompaction → 委托执行", async () => {
		const msgs: NexusMessage[] = [userMsg("hello world")];
		const ompFn: OmpCompactionFn = async (input) => ({
			summary: "omp summary",
			messages: [systemMsg("omp system"), ...input],
		});
		const result = await compact(msgs, { config: { strategy: "omp" }, ompCompaction: ompFn });
		expect(result.strategy).toBe("omp");
		expect(result.summary).toBe("omp summary");
		expect(result.messages.length).toBe(2); // system + original
		expect(result.tokensAfter).toBeGreaterThan(0);
	});

	test("omp 函数接收 previousSummary", async () => {
		let capturedPrev: string | undefined;
		const ompFn: OmpCompactionFn = async (_input, opts) => {
			capturedPrev = opts?.previousSummary;
			return { summary: "new", messages: [] };
		};
		await compact([userMsg("x")], {
			config: { strategy: "omp" },
			ompCompaction: ompFn,
			previousSummary: "PREV",
		});
		expect(capturedPrev).toBe("PREV");
	});
});

// ============================================================
// compact —— nexus 策略
// ============================================================

describe("compact —— nexus 策略", () => {
	test("短会话（< historyTurns）：仅触发局部压缩", async () => {
		const longText = "A".repeat(300);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText)]; // 跨 turn 重复
		const result = await compact(msgs, {
			config: { strategy: "nexus", interThreshold: 64 },
		});
		expect(result.strategy).toBe("nexus");
		expect(result.stages.inter).toBe(true);
		expect(result.stages.history).toBe(false);
		expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
	});

	test("长会话（> historyTurns）：触发 history compaction", async () => {
		const msgs: NexusMessage[] = [];
		for (let i = 0; i < 30; i++) {
			msgs.push(userMsg(`question ${i} with enough text to make it substantial`.repeat(5)));
			msgs.push(assistantMsg(`answer ${i} with enough text`.repeat(5)));
		}
		const result = await compact(msgs, {
			config: { strategy: "nexus", historyTurns: 10, keepRecentTurns: 2 },
		});
		expect(result.strategy).toBe("nexus");
		expect(result.stages.history).toBe(true);
		expect(result.summary).toBeTruthy();
		// 消息数大幅减少
		expect(result.messages.length).toBeLessThan(msgs.length);
		// token 显著减少
		expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
	});

	test("注入 sampler：history compaction 使用 LLM 摘要", async () => {
		const sampler: CompactionSampler = {
			sampleSummary: async (_msgs, _sys, _user) => "Summary: LLM-generated summary.",
		};
		const msgs: NexusMessage[] = [];
		for (let i = 0; i < 25; i++) {
			msgs.push(userMsg(`question ${i}`.repeat(20)));
			msgs.push(assistantMsg(`answer ${i}`.repeat(20)));
		}
		const result = await compact(msgs, {
			config: { strategy: "nexus", historyTurns: 5, keepRecentTurns: 2 },
			sampler,
		});
		expect(result.stages.history).toBe(true);
		expect(result.summary).toContain("LLM-generated summary");
	});

	test("nexus 策略返回 stages 标记每级是否触发", async () => {
		const longCode = Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const msgs: NexusMessage[] = [
			userMsg(`Code:\n\`\`\`ts\n${longCode}\n\`\`\``),
		];
		const result = await compact(msgs, { config: { strategy: "nexus", codeBlockSize: 10 } });
		expect(result.stages.code).toBe(true);
	});
});

// ============================================================
// compact —— hybrid 策略
// ============================================================

describe("compact —— hybrid 策略", () => {
	test("未注入 omp → 退化为 nexus", async () => {
		const longText = "B".repeat(300);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText)];
		const result = await compact(msgs, {
			config: { strategy: "hybrid", interThreshold: 64, historyTurns: 100 },
		});
		// 退化为 nexus：strategy 字段为 'hybrid'，但实际走 nexus 路径
		expect(result.strategy).toBe("hybrid");
		expect(result.stages.inter).toBe(true);
		expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
	});

	test("注入 omp → 两阶段（nexus 局部 + omp 全局）", async () => {
		const longText = "C".repeat(300);
		const msgs: NexusMessage[] = [userMsg(longText), userMsg(longText), assistantMsg("response")];
		const ompFn: OmpCompactionFn = async (input) => ({
			summary: "hybrid global summary",
			messages: [systemMsg("omp post-process"), ...input.slice(0, 1)],
		});
		const result = await compact(msgs, {
			config: { strategy: "hybrid", interThreshold: 64, historyTurns: 100 },
			ompCompaction: ompFn,
		});
		expect(result.strategy).toBe("hybrid");
		expect(result.stages.history).toBe(true); // omp 做了语义级摘要
		expect(result.summary).toBe("hybrid global summary");
		// Phase 1 nexus 局部压缩应触发 inter
		expect(result.stages.inter).toBe(true);
	});

	test("hybrid 不触发 nexus history（交给 omp）", async () => {
		// 大量 turn，但 hybrid 模式下 nexus 不应触发 history
		const msgs: NexusMessage[] = [];
		for (let i = 0; i < 50; i++) {
			msgs.push(userMsg(`q${i}`.repeat(20)));
		}
		const ompFn: OmpCompactionFn = async (input) => ({
			summary: "omp summary",
			messages: input,
		});
		const result = await compact(msgs, {
			config: { strategy: "hybrid", historyTurns: 10 },
			ompCompaction: ompFn,
		});
		// nexus history 阶段未触发（标记为 false）
		// 但 omp 阶段标记 history=true（语义级摘要）
		expect(result.stages.history).toBe(true);
		expect(result.summary).toBe("omp summary");
	});
});

// ============================================================
// 策略选择
// ============================================================

describe("策略选择", () => {
	test("config.strategy 决定执行路径", async () => {
		const msgs: NexusMessage[] = [userMsg("x")];

		const ompResult = await compact(msgs, { config: { strategy: "omp" } });
		expect(ompResult.strategy).toBe("omp");

		const nexusResult = await compact(msgs, { config: { strategy: "nexus" } });
		expect(nexusResult.strategy).toBe("nexus");

		const hybridResult = await compact(msgs, { config: { strategy: "hybrid" } });
		expect(hybridResult.strategy).toBe("hybrid");
	});

	test("默认 strategy 为 nexus", () => {
		const cfg = resolveConfig();
		expect(cfg.strategy).toBe("nexus");
	});
});

// ============================================================
// 端到端：100-turn 会话 token 压缩
// ============================================================

describe("100-turn 会话压缩（端到端）", () => {
	test("nexus 策略显著减少 token", async () => {
		const session = build100TurnSession();
		const tokensBefore = estimateMessagesTokens(session);
		const result = await compact(session, {
			config: { strategy: "nexus", historyTurns: 20, keepRecentTurns: 4, codeBlockSize: 15 },
		});
		const reduction = (tokensBefore - result.tokensAfter) / tokensBefore;
		// 至少 20% 压缩
		expect(reduction).toBeGreaterThanOrEqual(0.2);
		expect(result.stages.history).toBe(true);
		expect(result.messages.length).toBeLessThan(session.length);
	});
});
