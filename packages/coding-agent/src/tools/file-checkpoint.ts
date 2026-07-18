/**
 * Nexus 文件级 checkpoint/rewind 集成模块（M3 里程碑）。
 *
 * 在 bash/edit/write 工具执行前自动创建 checkpoint，并提供 `/rewind` 命令
 * 所需的 list/restore/diff 接口。
 *
 * ## 与 omp 会话级 checkpoint 的关系
 *
 * omp 已有 `tools/checkpoint.ts`（会话级，仅截断对话历史）。本模块是文件级
 * （真正还原磁盘文件内容），两者互补，不修改 omp 已有 API。
 *
 * ## 配置项
 *
 * - `checkpoint.autoEnabled`（bool, 默认 false）— 是否在 bash/edit/write 前自动打 checkpoint
 * - `checkpoint.autoInterval`（秒, 默认 30）— 自动 checkpoint 的最小间隔
 * - `checkpoint.maxSizeMb`（MB, 默认 256）— checkpoint 总磁盘占用上限
 * - `checkpoint.swapPolicy`（"lru" | "lru-size" | "fifo" | "none", 默认 "lru"）— 驱逐策略
 *
 * ## Native addon 加载
 *
 * `@nexus-agent/checkpoint` 是 NAPI 原生模块，可能未在某些环境编译。
 * 用动态 import + 缓存确保：
 *  1. 默认 `checkpoint.autoEnabled = false` 时完全不加载原生模块；
 *  2. 加载失败时优雅降级并给出明确错误信息；
 *  3. 多次调用复用同一个 Promise，避免重复 require 触发 dlopen。
 */

import { logger } from "@oh-my-pi/pi-utils";

import type { ToolSession } from "./index";

// ────────────────────────────────────────────────────────────────────────────
// Native addon loader（镜像 bash.ts 的 loadSandboxModule 模式）
// ────────────────────────────────────────────────────────────────────────────

type CheckpointModule = typeof import("@nexus-agent/checkpoint");
type CheckpointStoreHandle = CheckpointModule["CheckpointStoreHandle"];
type CheckpointMetaDto = Awaited<ReturnType<CheckpointStoreHandle["list"]>>[number];
type RestoreResultDto = Awaited<ReturnType<CheckpointStoreHandle["restore"]>>;
type DiffResultDto = Awaited<ReturnType<CheckpointStoreHandle["diff"]>>;

let checkpointModulePromise: Promise<CheckpointModule | null> | null = null;

async function loadCheckpointModule(): Promise<CheckpointModule | null> {
	if (checkpointModulePromise !== null) return checkpointModulePromise;
	checkpointModulePromise = (async () => {
		try {
			return await import("@nexus-agent/checkpoint");
		} catch (error) {
			logger.warn(
				"Failed to load @nexus-agent/checkpoint native addon; file-level checkpoint disabled",
				{ error },
			);
			return null;
		}
	})();
	return checkpointModulePromise;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-session store cache
// ────────────────────────────────────────────────────────────────────────────

/** 每个 session 一个 CheckpointStoreHandle 缓存（弱引用，session 结束自动 GC）。 */
const sessionStoreCache = new WeakMap<ToolSession, Promise<CheckpointStoreHandle | null>>();

/** 自增 prompt index（用于 generateCheckpointId）。 */
const sessionPromptIndex = new WeakMap<ToolSession, number>();

/** 上次自动 checkpoint 的时间戳（ms），用于 autoInterval 节流。 */
const lastAutoCheckpointMs = new WeakMap<ToolSession, number>();

/**
 * 获取或创建 session 的 CheckpointStoreHandle。
 *
 * 读取 `checkpoint.maxSizeMb` / `checkpoint.swapPolicy` 配置，懒加载 native addon。
 * 若 addon 不可用或 `checkpoint.autoEnabled = false`，返回 null。
 */
export async function getFileCheckpointStore(
	session: ToolSession,
): Promise<CheckpointStoreHandle | null> {
	// autoEnabled 关闭时不加载
	if (!session.settings.get("checkpoint.autoEnabled")) {
		return null;
	}

	const cached = sessionStoreCache.get(session);
	if (cached) return cached;

	const promise = (async () => {
		const mod = await loadCheckpointModule();
		if (!mod) return null;

		const maxSizeMb = session.settings.get("checkpoint.maxSizeMb") ?? 256;
		const swapPolicy = session.settings.get("checkpoint.swapPolicy") ?? "lru";
		const sessionId = session.getSessionFile?.() ?? "default-session";

		try {
			return mod.createCheckpointStore({
				cwd: session.cwd,
				sessionId,
				maxCheckpoints: 64,
				maxSizeMb: typeof maxSizeMb === "number" ? maxSizeMb : 256,
				swapPolicy: typeof swapPolicy === "string" ? swapPolicy : "lru",
			});
		} catch (error) {
			logger.warn("Failed to create checkpoint store", { error });
			return null;
		}
	})();

	sessionStoreCache.set(session, promise);
	return promise;
}

/**
 * 在 bash/edit/write 工具执行前自动创建 checkpoint。
 *
 * 仅当 `checkpoint.autoEnabled = true` 且距上次 checkpoint 超过
 * `checkpoint.autoInterval` 秒时才实际创建。
 *
 * @param session 当前 tool session
 * @param paths   即将被修改的文件路径列表（相对 cwd 或绝对）
 * @returns 新建的 checkpoint id，或 null（未创建）
 */
export async function maybeAutoCheckpoint(
	session: ToolSession,
	paths: string[],
): Promise<number | null> {
	const store = await getFileCheckpointStore(session);
	if (!store) return null;

	// 节流：检查 autoInterval
	const intervalSec = session.settings.get("checkpoint.autoInterval") ?? 30;
	const intervalMs = (typeof intervalSec === "number" ? intervalSec : 30) * 1000;
	const now = Date.now();
	const lastMs = lastAutoCheckpointMs.get(session) ?? 0;
	if (intervalMs > 0 && now - lastMs < intervalMs) {
		return null; // 距上次 checkpoint 太近，跳过
	}

	// 自增 prompt index
	const nextIndex = (sessionPromptIndex.get(session) ?? -1) + 1;
	sessionPromptIndex.set(session, nextIndex);

	try {
		const id = await store.create(nextIndex, `auto-${nextIndex}`, paths);
		lastAutoCheckpointMs.set(session, now);
		return id;
	} catch (error) {
		logger.warn("Auto checkpoint creation failed", { error, paths });
		return null;
	}
}

/**
 * 列出当前 session 的所有 checkpoint 元数据。
 *
 * 供 `/rewind list` 命令使用。
 */
export async function listCheckpoints(session: ToolSession): Promise<CheckpointMetaDto[]> {
	const store = await getFileCheckpointStore(session);
	if (!store) return [];
	try {
		return await store.list();
	} catch (error) {
		logger.warn("listCheckpoints failed", { error });
		return [];
	}
}

/**
 * 回滚到指定 checkpoint。
 *
 * 供 `/rewind <id>` 命令使用。
 */
export async function restoreCheckpoint(
	session: ToolSession,
	id: number,
): Promise<RestoreResultDto | null> {
	const store = await getFileCheckpointStore(session);
	if (!store) {
		return {
			success: false,
			targetPromptIndex: id,
			revertedFiles: [],
			cleanFiles: [],
			conflicts: [],
			error: "checkpoint.autoEnabled 为 false 或 native addon 不可用",
		};
	}
	try {
		return await store.restore(id);
	} catch (error) {
		return {
			success: false,
			targetPromptIndex: id,
			revertedFiles: [],
			cleanFiles: [],
			conflicts: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * 计算两个 checkpoint 之间的差异。
 *
 * 供 `/rewind diff <id>` 命令使用。
 */
export async function diffCheckpoints(
	session: ToolSession,
	fromId: number,
	toId: number,
): Promise<DiffResultDto | null> {
	const store = await getFileCheckpointStore(session);
	if (!store) return null;
	try {
		return await store.diff(fromId, toId);
	} catch (error) {
		logger.warn("diffCheckpoints failed", { error });
		return null;
	}
}

/**
 * 检查文件级 checkpoint 系统是否可用（autoEnabled + native addon 已加载）。
 */
export async function isFileCheckpointAvailable(session: ToolSession): Promise<boolean> {
	const store = await getFileCheckpointStore(session);
	return store !== null;
}
