/**
 * 策略调度器（strategy dispatcher）
 *
 * 根据 `compaction.strategy` 配置选择执行路径：
 * - `omp`：完全委托给 omp 原生 compaction 函数（调用方注入）
 * - `nexus`：依次执行 nexus 四级 compaction
 *   1. code-compaction（局部，无 LLM）
 *   2. intra-compaction（局部，无 LLM）
 *   3. inter-compaction（局部，无 LLM）
 *   4. history-compaction（全局，需 LLM；仅当超过 historyTurns 阈值）
 * - `hybrid`：先走 nexus code + intra（局部压缩），再走 omp 默认（全局摘要）
 *
 * 该设计保证：
 * - 不修改 omp 已有 compaction.ts 的 API
 * - omp 用户可继续使用原生策略（向后兼容）
 * - nexus / hybrid 策略由调用方显式启用，通过依赖注入接入 omp 函数
 */

import type {
	NexusMessage,
	NexusCompactionConfig,
	CompactionStrategy,
	CompactionSampler,
	CompactionResult,
	OmpCompactionFn,
} from "./types";
import { DEFAULT_NEXUS_CONFIG } from "./types";
import { estimateMessagesTokens } from "./tokenizer";
import { interCompaction } from "./inter-compaction";
import { intraCompaction } from "./intra-compaction";
import { codeCompaction } from "./code-compaction";
import { historyCompaction } from "./history-compaction";

/**
 * Compaction 调度器选项
 */
export interface CompactionDispatcherOptions {
	/** nexus 配置（可选，缺省用 DEFAULT_NEXUS_CONFIG） */
	config?: Partial<NexusCompactionConfig>;
	/** LLM 采样器（用于 history compaction；为 null 则跳过 history） */
	sampler?: CompactionSampler | null;
	/** omp 原生 compaction 函数（strategy=omp/hybrid 时必需） */
	ompCompaction?: OmpCompactionFn;
	/** 上一轮摘要（增量更新） */
	previousSummary?: string;
	/** AbortSignal */
	signal?: AbortSignal;
}

/**
 * 解析配置：合并默认值与用户配置。
 */
export function resolveConfig(partial?: Partial<NexusCompactionConfig>): NexusCompactionConfig {
	return { ...DEFAULT_NEXUS_CONFIG, ...(partial ?? {}) };
}

/**
 * 执行 nexus 四级 compaction（无 omp 调用）。
 *
 * 顺序：code → intra → inter → history
 * 前三级为纯结构化压缩，无 LLM；history 需 sampler。
 */
export async function runNexusCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
	sampler: CompactionSampler | null,
	previousSummary?: string,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const tokensBefore = estimateMessagesTokens(messages);
	let working = messages;
	const stages = { inter: false, intra: false, code: false, history: false };
	let summary: string | undefined;

	// Step 1: code-compaction（局部）
	const codeResult = codeCompaction(working, config);
	working = codeResult.messages;
	stages.code = codeResult.stats.applied;

	// Step 2: intra-compaction（局部）
	const intraResult = intraCompaction(working, config);
	working = intraResult.messages;
	stages.intra = intraResult.stats.applied;

	// Step 3: inter-compaction（局部）
	const interResult = interCompaction(working, config);
	working = interResult.messages;
	stages.inter = interResult.stats.applied;

	// Step 4: history-compaction（全局，需 LLM）
	const historyResult = await historyCompaction(working, config, sampler, previousSummary, signal);
	working = historyResult.messages;
	stages.history = historyResult.stats.applied;
	summary = historyResult.summary;

	const tokensAfter = estimateMessagesTokens(working);
	const turnsCompacted = stages.history
		? historyResult.stats.turnsSummarized
		: (codeResult.stats.blocksCompacted > 0 ? 1 : 0) +
			(intraResult.stats.blocksMerged > 0 ? 1 : 0) +
			(interResult.stats.replacements > 0 ? 1 : 0);

	return {
		messages: working,
		tokensBefore,
		tokensAfter,
		turnsCompacted,
		strategy: "nexus",
		stages,
		summary,
	};
}

/**
 * 执行 omp 原生 compaction（委托给调用方注入的函数）。
 */
export async function runOmpCompaction(
	messages: NexusMessage[],
	ompFn: OmpCompactionFn,
	options?: { previousSummary?: string; signal?: AbortSignal; customInstructions?: string },
): Promise<CompactionResult> {
	const tokensBefore = estimateMessagesTokens(messages);
	const result = await ompFn(messages, options);
	const tokensAfter = estimateMessagesTokens(result.messages);
	return {
		messages: result.messages,
		tokensBefore,
		tokensAfter,
		turnsCompacted: 1,
		strategy: "omp",
		stages: { inter: false, intra: false, code: false, history: false },
		summary: result.summary,
	};
}

/**
 * 执行 hybrid compaction：先 nexus 局部压缩，再 omp 全局摘要。
 *
 * 适用场景：nexus 的 code/intra/inter 做精细结构化压缩，
 * omp 的全局 LLM 摘要做语义级压缩，两者互补。
 */
export async function runHybridCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
	sampler: CompactionSampler | null,
	ompFn: OmpCompactionFn,
	options?: { previousSummary?: string; signal?: AbortSignal; customInstructions?: string },
): Promise<CompactionResult> {
	const tokensBefore = estimateMessagesTokens(messages);
	let working = messages;
	const stages = { inter: false, intra: false, code: false, history: false };

	// Phase 1: nexus 局部压缩（不触发 history）
	const localConfig: NexusCompactionConfig = {
		...config,
		// 局部阶段禁用 history（交给 omp）
		historyTurns: Number.MAX_SAFE_INTEGER,
	};
	const codeResult = codeCompaction(working, localConfig);
	working = codeResult.messages;
	stages.code = codeResult.stats.applied;

	const intraResult = intraCompaction(working, localConfig);
	working = intraResult.messages;
	stages.intra = intraResult.stats.applied;

	const interResult = interCompaction(working, localConfig);
	working = interResult.messages;
	stages.inter = interResult.stats.applied;

	// Phase 2: omp 全局摘要
	const ompResult = await ompFn(working, options);
	working = ompResult.messages;
	stages.history = true; // omp 做了语义级摘要

	const tokensAfter = estimateMessagesTokens(working);

	return {
		messages: working,
		tokensBefore,
		tokensAfter,
		turnsCompacted: 1,
		strategy: "hybrid",
		stages,
		summary: ompResult.summary,
	};
}

/**
 * 主调度入口：根据 strategy 选择执行路径。
 *
 * @param messages 原始消息列表
 * @param options 调度选项（含 strategy）
 */
export async function compact(
	messages: NexusMessage[],
	options?: CompactionDispatcherOptions,
): Promise<CompactionResult> {
	const config = resolveConfig(options?.config);
	const strategy: CompactionStrategy = config.strategy;
	const sampler = options?.sampler ?? null;

	switch (strategy) {
		case "omp": {
			if (!options?.ompCompaction) {
				// 未注入 omp 函数：原样返回（向后兼容）
				const tokens = estimateMessagesTokens(messages);
				return {
					messages,
					tokensBefore: tokens,
					tokensAfter: tokens,
					turnsCompacted: 0,
					strategy: "omp",
					stages: { inter: false, intra: false, code: false, history: false },
				};
			}
			return runOmpCompaction(messages, options.ompCompaction, {
				previousSummary: options.previousSummary,
				signal: options.signal,
			});
		}
		case "nexus": {
			return runNexusCompaction(messages, config, sampler, options?.previousSummary, options?.signal);
		}
		case "hybrid": {
			if (!options?.ompCompaction) {
				// 未注入 omp 函数：退化为纯 nexus
				return runNexusCompaction(messages, config, sampler, options?.previousSummary, options?.signal);
			}
			return runHybridCompaction(messages, config, sampler, options.ompCompaction, {
				previousSummary: options?.previousSummary,
				signal: options?.signal,
			});
		}
	}
}
