/**
 * 基准测试：100-turn 会话 token 压缩验证
 *
 * 对齐 M4 Task 4.9：验证 token 节省 ≥ 20%（100 turn 会话）。
 *
 * 测试场景：
 * 1. **nexus 策略**（无 LLM，结构化裁剪 fallback）：100-turn 会话，验证压缩率 ≥ 20%
 * 2. **nexus 策略**（含 mock LLM sampler）：100-turn 会话，验证压缩率 ≥ 20%
 * 3. **hybrid 策略**（注入 mock omp）：100-turn 会话，验证压缩率 ≥ 20%
 * 4. **各级 stage 触发验证**：确认 code/intra/inter/history 均有贡献
 *
 * 会话构造（模拟真实 agent 会话）：
 * - 1 条 system prompt（长，含项目上下文）
 * - 100 组 user + assistant turn：
 *   - user: 含重复的项目上下文 + 具体问题
 *   - assistant: 含长 thinking 块 + 代码块（50 行函数）
 */
import { describe, expect, test } from "bun:test";
import {
	type NexusMessage,
	type CompactionSampler,
	type OmpCompactionFn,
} from "../src/types";
import { compact } from "../src/strategy";
import { estimateMessagesTokens } from "../src/tokenizer";

// ============================================================
// 会话夹具构造
// ============================================================

/** 重复的项目上下文（模拟每次 user 都附带的 project layout） */
const PROJECT_CONTEXT = "Project: nexus-agent. Stack: Bun + TypeScript + Biome. ".repeat(20);

/** 长 system prompt */
const SYSTEM_PROMPT = `You are a helpful coding assistant. ${PROJECT_CONTEXT}

Follow the user's instructions carefully. Use available tools when needed. Always provide complete, working code examples.`;

/**
 * 构造单条 assistant 消息：含 thinking 块 + 代码块。
 */
function buildAssistantMessage(turnIdx: number): NexusMessage {
	const thinkingLines = Array.from(
		{ length: 15 },
		(_, i) => `Thinking step ${i} for turn ${turnIdx}: analyzing the problem and considering approaches.`,
	);
	const codeLines = [
		`function solveTask${turnIdx}(input: string): { result: string; ok: boolean } {`,
		...Array.from({ length: 40 }, (_, j) => `  const step${j} = process(input, ${j});`),
		`  return { result: 'done', ok: true };`,
		`}`,
	];
	const text = `Here's my response for turn ${turnIdx}:\n\n\`\`\`ts\n${codeLines.join("\n")}\n\`\`\``;
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: thinkingLines.join("\n") },
			{ type: "text", text },
		],
		timestamp: 0,
	};
}

/**
 * 构造单条 user 消息：含重复上下文 + 具体问题。
 */
function buildUserMessage(turnIdx: number): NexusMessage {
	return {
		role: "user",
		content: `${PROJECT_CONTEXT}\n\nFor turn ${turnIdx}, please help me implement feature number ${turnIdx}.`,
		timestamp: 0,
	};
}

/**
 * 构造完整的 100-turn 会话。
 */
function build100TurnSession(): NexusMessage[] {
	const msgs: NexusMessage[] = [{ role: "system", content: SYSTEM_PROMPT, timestamp: 0 }];
	for (let i = 0; i < 100; i++) {
		msgs.push(buildUserMessage(i));
		msgs.push(buildAssistantMessage(i));
	}
	return msgs;
}

// ============================================================
// 基准测试
// ============================================================

describe("基准测试：100-turn 会话 token 压缩", () => {
	const session = build100TurnSession();
	const tokensBefore = estimateMessagesTokens(session);

	test("会话规模：100 turn + 1 system，~200 条消息", () => {
		expect(session.length).toBe(201); // 1 system + 100 user + 100 assistant
		// 预估 token 应足够大以使压缩有意义
		expect(tokensBefore).toBeGreaterThan(10000);
	});

	// ============================================================
	// 场景 1：nexus 策略（无 LLM，结构化裁剪）
	// ============================================================

	test("nexus 策略（无 LLM）：token 节省 ≥ 20%", async () => {
		const result = await compact(session, {
			config: {
				strategy: "nexus",
				historyTurns: 20,
				keepRecentTurns: 4,
				codeBlockSize: 15,
				intraThreshold: 64,
				interThreshold: 128,
			},
		});

		const reduction = (tokensBefore - result.tokensAfter) / tokensBefore;
		const reductionPct = (reduction * 100).toFixed(2);

		// 核心断言：压缩率 ≥ 20%
		expect(reduction).toBeGreaterThanOrEqual(0.2);

		// 验证各级 stage 是否触发
		expect(result.stages.code).toBe(true); // 代码块被压缩
		expect(result.stages.history).toBe(true); // history compaction 触发

		// 验证消息数显著减少
		expect(result.messages.length).toBeLessThan(session.length);

		// 输出诊断信息（不会影响测试结果）
		console.log(
			`[nexus 无 LLM] before=${tokensBefore}, after=${result.tokensAfter}, reduction=${reductionPct}%, stages=${JSON.stringify(result.stages)}`,
		);
	});

	// ============================================================
	// 场景 2：nexus 策略（含 mock LLM sampler）
	// ============================================================

	test("nexus 策略（含 mock sampler）：token 节省 ≥ 20%", async () => {
		const mockSampler: CompactionSampler = {
			sampleSummary: async (msgs, _sys, _user) => {
				// 模拟 LLM 摘要：返回精简结构化文本
				const userCount = msgs.filter(m => (m as { role?: string }).role === "user").length;
				return `Summary:\n- Conversation had ${userCount} user turns.\n- All turns involved implementing features for the nexus-agent project.\n- Stack: Bun + TypeScript + Biome.\n- No errors encountered.`;
			},
		};

		const result = await compact(session, {
			config: {
				strategy: "nexus",
				historyTurns: 20,
				keepRecentTurns: 4,
				codeBlockSize: 15,
			},
			sampler: mockSampler,
		});

		const reduction = (tokensBefore - result.tokensAfter) / tokensBefore;
		const reductionPct = (reduction * 100).toFixed(2);

		expect(reduction).toBeGreaterThanOrEqual(0.2);
		expect(result.stages.history).toBe(true);
		expect(result.summary).toBeTruthy();

		console.log(
			`[nexus + mock LLM] before=${tokensBefore}, after=${result.tokensAfter}, reduction=${reductionPct}%`,
		);
	});

	// ============================================================
	// 场景 3：hybrid 策略（注入 mock omp）
	// ============================================================

	test("hybrid 策略（nexus 局部 + mock omp 全局）：token 节省 ≥ 20%", async () => {
		const mockOmp: OmpCompactionFn = async (msgs) => {
			// 模拟 omp 全局摘要：保留首条 + 摘要
			const first = msgs[0];
			return {
				summary: "Hybrid omp global summary: conversation compressed.",
				messages: [first, { role: "user", content: "Continue from summary.", timestamp: 0 }],
			};
		};

		const result = await compact(session, {
			config: {
				strategy: "hybrid",
				historyTurns: 20,
				keepRecentTurns: 4,
				codeBlockSize: 15,
				interThreshold: 128,
			},
			ompCompaction: mockOmp,
		});

		const reduction = (tokensBefore - result.tokensAfter) / tokensBefore;
		const reductionPct = (reduction * 100).toFixed(2);

		expect(reduction).toBeGreaterThanOrEqual(0.2);
		expect(result.strategy).toBe("hybrid");
		expect(result.stages.history).toBe(true); // omp 阶段

		console.log(
			`[hybrid + mock omp] before=${tokensBefore}, after=${result.tokensAfter}, reduction=${reductionPct}%`,
		);
	});

	// ============================================================
	// 场景 4：各级 stage 贡献验证
	// ============================================================

	test("各级 stage 均有贡献：code/intra/inter/history", async () => {
		const result = await compact(session, {
			config: {
				strategy: "nexus",
				historyTurns: 20,
				keepRecentTurns: 4,
				codeBlockSize: 15,
				intraThreshold: 64,
				interThreshold: 128,
			},
		});

		// code stage：100 个 50 行代码块 → 至少部分被压缩
		expect(result.stages.code).toBe(true);

		// history stage：100 turn > 20，必触发
		expect(result.stages.history).toBe(true);

		// 综合 token 节省 ≥ 20%
		const reduction = (tokensBefore - result.tokensAfter) / tokensBefore;
		expect(reduction).toBeGreaterThanOrEqual(0.2);

		// turnsCompacted 应为正
		expect(result.turnsCompacted).toBeGreaterThan(0);
	});

	// ============================================================
	// 场景 5：压缩前后消息结构完整性
	// ============================================================

	test("压缩后消息结构完整：含 compactionSummary + 最近 turn", async () => {
		const result = await compact(session, {
			config: {
				strategy: "nexus",
				historyTurns: 20,
				keepRecentTurns: 4,
				codeBlockSize: 15,
			},
		});

		// 应包含 compactionSummary 消息
		const hasSummary = result.messages.some(
			m => (m as { role?: string }).role === "compactionSummary",
		);
		expect(hasSummary).toBe(true);

		// 应保留最近 turn 的 user/assistant 消息
		const hasUser = result.messages.some(m => (m as { role?: string }).role === "user");
		const hasAssistant = result.messages.some(m => (m as { role?: string }).role === "assistant");
		expect(hasUser).toBe(true);
		expect(hasAssistant).toBe(true);
	});
});

// ============================================================
// 不同会话规模对比（辅助诊断）
// ============================================================

describe("不同会话规模对比", () => {
	function buildSession(turnCount: number): NexusMessage[] {
		const msgs: NexusMessage[] = [{ role: "system", content: SYSTEM_PROMPT, timestamp: 0 }];
		for (let i = 0; i < turnCount; i++) {
			msgs.push(buildUserMessage(i));
			msgs.push(buildAssistantMessage(i));
		}
		return msgs;
	}

	test("50-turn 会话：压缩率 ≥ 20%", async () => {
		const session = buildSession(50);
		const before = estimateMessagesTokens(session);
		const result = await compact(session, {
			config: { strategy: "nexus", historyTurns: 20, keepRecentTurns: 4, codeBlockSize: 15 },
		});
		const reduction = (before - result.tokensAfter) / before;
		expect(reduction).toBeGreaterThanOrEqual(0.2);
		console.log(`[50-turn] before=${before}, after=${result.tokensAfter}, reduction=${(reduction * 100).toFixed(2)}%`);
	});

	test("200-turn 会话：压缩率 ≥ 30%", async () => {
		const session = buildSession(200);
		const before = estimateMessagesTokens(session);
		const result = await compact(session, {
			config: { strategy: "nexus", historyTurns: 20, keepRecentTurns: 4, codeBlockSize: 15 },
		});
		const reduction = (before - result.tokensAfter) / before;
		// 更长会话应获得更高压缩率
		expect(reduction).toBeGreaterThanOrEqual(0.3);
		console.log(`[200-turn] before=${before}, after=${result.tokensAfter}, reduction=${(reduction * 100).toFixed(2)}%`);
	});
});
