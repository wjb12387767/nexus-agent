/**
 * Nexus precompaction 集成层
 *
 * 把 `@nexus-agent/compaction` 的局部压缩（code/intra/inter，无 LLM）
 * 接入 omp 原生 compaction 流程：在 omp `compact()` 调用 LLM 摘要前，
 * 先对 `messagesToSummarize` 做结构化压缩，减少摘要输入 token。
 *
 * 设计原则：
 * - 默认 `off`，向后兼容（不影响 omp 原生行为）
 * - 通过 `CompactionSettings.nexusPrecompact` 显式启用
 * - 仅做局部压缩（code/intra/inter），不触发 history compaction（LLM 摘要交给 omp）
 * - 通过 structural typing 兼容 `AgentMessage` 与 `NexusMessage`，不强制运行时依赖
 */

import {
	codeCompaction,
	intraCompaction,
	interCompaction,
	DEFAULT_NEXUS_CONFIG,
	type NexusMessage,
	type NexusCompactionConfig,
} from "@nexus-agent/compaction";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";

/** nexus 预压缩模式 */
export type NexusPrecompactMode =
	| "off" // 不启用（默认，向后兼容）
	| "code" // 仅代码块压缩
	| "code-intra" // 代码块 + 单 turn 内重复合并
	| "code-intra-inter"; // 代码块 + 单 turn + 跨 turn（完整局部压缩）

/** 预压缩结果 */
export interface NexusPrecompactResult {
	/** 压缩后的消息列表（结构兼容 AgentMessage） */
	messages: AgentMessage[];
	/** 是否实际应用了压缩 */
	applied: boolean;
	/** 各阶段统计 */
	stats: {
		/** 压缩的代码块数 */
		codeBlocks: number;
		/** 合并的重复 block 数 */
		intraMerged: number;
		/** 跨 turn 替换数 */
		interReplaced: number;
	};
}

/**
 * 在 omp compaction 调用 LLM 摘要前，先用 nexus 局部压缩预处理消息列表。
 *
 * 仅做无 LLM 的结构化压缩（code/intra/inter），不触发 history compaction。
 * 全局语义级摘要仍由 omp 原生流程负责。
 *
 * @param messages 待摘要的 AgentMessage 列表
 * @param mode 预压缩模式（off 时不做任何处理）
 * @param configOverride 可选的 nexus config 覆盖（阈值等）
 */
export function precompactWithNexus(
	messages: AgentMessage[],
	mode: NexusPrecompactMode,
	configOverride?: Partial<NexusCompactionConfig>,
): NexusPrecompactResult {
	const emptyStats = { codeBlocks: 0, intraMerged: 0, interReplaced: 0 };

	if (mode === "off" || messages.length === 0) {
		return { messages, applied: false, stats: emptyStats };
	}

	const config: NexusCompactionConfig = { ...DEFAULT_NEXUS_CONFIG, ...configOverride };

	// AgentMessage 与 NexusMessage 结构兼容（role/content 字段对齐），
	// 通过 unknown 双向转换避免 TS 联合类型窄化问题。
	let working = messages as unknown as NexusMessage[];
	const stats = { ...emptyStats };

	try {
		// Stage 1: code-compaction（代码块签名保留 + 占位）
		const codeResult = codeCompaction(working, config);
		working = codeResult.messages;
		stats.codeBlocks = codeResult.stats.blocksCompacted;

		if (mode === "code") {
			return finalize(working, stats);
		}

		// Stage 2: intra-compaction（单 turn 内重复合并 + thinking 折叠）
		const intraResult = intraCompaction(working, config);
		working = intraResult.messages;
		stats.intraMerged = intraResult.stats.blocksMerged;

		if (mode === "code-intra") {
			return finalize(working, stats);
		}

		// Stage 3: inter-compaction（跨 turn 重复去重）
		const interResult = interCompaction(working, config);
		working = interResult.messages;
		stats.interReplaced = interResult.stats.replacements;

		return finalize(working, stats);
	} catch (err) {
		// 任何 nexus 压缩异常都降级为原样返回，绝不阻塞 omp 主流程
		logger.warn("nexus precompaction failed, falling back to original messages", {
			error: err instanceof Error ? err.message : String(err),
			mode,
		});
		return { messages, applied: false, stats: emptyStats };
	}
}

/** 内部：转换回 AgentMessage 并计算 applied 标志 */
function finalize(working: NexusMessage[], stats: NexusPrecompactResult["stats"]): NexusPrecompactResult {
	const applied = stats.codeBlocks > 0 || stats.intraMerged > 0 || stats.interReplaced > 0;
	return {
		messages: working as unknown as AgentMessage[],
		applied,
		stats,
	};
}
