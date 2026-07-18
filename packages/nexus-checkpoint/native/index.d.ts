/**
 * Nexus Checkpoint NAPI bindings — TypeScript type declarations.
 *
 * 镜像 Rust 侧 `crates/nexus-checkpoint/src/napi.rs` 中通过 `#[napi]` 暴露的
 * 接口。这些类型由 napi-rs 在构建时自动生成；此文件在尚未运行 `napi build`
 * 时提供手写占位，使 TS 侧可在无 .node 的情况下做类型检查。
 */

/**
 * Checkpoint store 创建选项。
 */
export interface CheckpointStoreOptions {
	/**
	 * 工作区根目录（cwd）。
	 */
	cwd: string;
	/**
	 * Session ID（用于隔离不同 session 的 checkpoint）。
	 */
	sessionId: string;
	/**
	 * 最大保留 checkpoint 数量（默认 64）。
	 */
	maxCheckpoints?: number | null;
	/**
	 * 最大总字节数（MB，默认 256）。
	 */
	maxSizeMb?: number | null;
	/**
	 * 驱逐策略（"lru" | "lru-size" | "fifo" | "none"，默认 "lru"）。
	 */
	swapPolicy?: string | null;
}

/**
 * Checkpoint 元数据（TS 侧）。
 */
export interface CheckpointMetaDto {
	/** Checkpoint ID（即 prompt_index）。 */
	id: number;
	/** 用户可读标签。 */
	label: string;
	/** 创建时刻（RFC 3339 格式）。 */
	createdAt: string;
	/** 捕获的文件数。 */
	numFiles: number;
	/** 估算的序列化大小（字节）。 */
	sizeBytes: number;
}

/**
 * 单个文件的 rewind 冲突（TS 侧）。
 */
export interface FileRewindConflictDto {
	/** 文件路径。 */
	path: string;
	/** 冲突类型：`"deleted_externally"` | `"created_externally"` | `"modified_externally"`。 */
	conflictType: string;
}

/**
 * restore 操作的结果（TS 侧）。
 */
export interface RestoreResultDto {
	/** 是否完全成功（无 IO 错误）。 */
	success: boolean;
	/** 目标 checkpoint 的 prompt_index。 */
	targetPromptIndex: number;
	/** 已还原的文件路径列表。 */
	revertedFiles: string[];
	/** 与 after 快照一致、无需还原的文件路径列表。 */
	cleanFiles: string[];
	/** 检测到的冲突列表（不阻断回滚，仅记录）。 */
	conflicts: FileRewindConflictDto[];
	/** 错误信息（success=false 时存在）。 */
	error?: string | null;
}

/**
 * diff 操作的结果（TS 侧）。
 */
export interface DiffResultDto {
	/** to 中新增的文件路径（from 中不存在）。 */
	added: string[];
	/** to 中修改的文件路径（from 中存在但 hash 不同）。 */
	modified: string[];
	/** from 中存在但 to 中不存在的文件路径。 */
	removed: string[];
}

/**
 * Checkpoint store 句柄。包装 Rust 侧的 `CheckpointStore`，
 * 向 TS 侧暴露 create/restore/list/diff。
 *
 * 平台支持：
 * - Linux: btrfs `FICLONE` / overlayfs reflink（O(1) CoW，优先尝试）
 * - macOS: APFS `clonefile(2)` reflink（O(1) CoW，优先尝试）
 * - Windows: 全量拷贝（无 reflink），通过 sha256 去重避免重复存储
 */
export class CheckpointStoreHandle {
	/**
	 * 是否在 reflink-capable 文件系统上（btrfs/apfs 等）。
	 * Windows 永远为 false。
	 */
	readonly reflinkCapable: boolean;
	/**
	 * 工作区根目录。
	 */
	readonly cwd: string;
	/**
	 * store 目录的绝对路径。
	 */
	readonly storeDir: string;
	/**
	 * 当前缓存中的 checkpoint 数量。
	 */
	readonly len: number;
	/**
	 * 创建一个 checkpoint：捕获 `paths` 的当前快照。
	 *
	 * @param promptIndex - prompt 索引（0-based，单调递增）
	 * @param label - 用户可读标签
	 * @param paths - 要捕获的文件路径（相对 cwd 或绝对）
	 * @returns 新建 checkpoint 的 id（即 promptIndex）
	 */
	create(promptIndex: number, label: string, paths: string[]): Promise<number>;
	/**
	 * 回滚到指定 checkpoint：还原所有 before 快照到磁盘，并截断 >= id 的所有 checkpoint。
	 *
	 * @param promptId - 要回滚到的 checkpoint id
	 * @returns 回滚结果（已还原文件、冲突、错误等）
	 */
	restore(promptId: number): Promise<RestoreResultDto>;
	/**
	 * 列出所有 checkpoint 的元数据（按 id 升序）。
	 */
	list(): Promise<CheckpointMetaDto[]>;
	/**
	 * 计算两个 checkpoint 之间的文件差异。
	 *
	 * @param fromId - 起始 checkpoint id
	 * @param toId - 目标 checkpoint id
	 * @returns 差异结果（added/modified/removed）
	 */
	diff(fromId: number, toId: number): Promise<DiffResultDto>;
	/**
	 * 删除 `>= target` 的所有 checkpoint（缓存 + 磁盘）。
	 *
	 * @param target - 起始 prompt_index（含）
	 */
	truncateFrom(target: number): Promise<void>;
	/**
	 * 更新驱逐策略配置（运行时调整）。
	 *
	 * @param maxCheckpoints - 新的最大 checkpoint 数量
	 * @param maxSizeMb - 新的最大总字节数（MB）
	 * @param swapPolicy - 新的驱逐策略（"lru" | "lru-size" | "fifo" | "none"）
	 */
	updatePolicy(
		maxCheckpoints?: number | null,
		maxSizeMb?: number | null,
		swapPolicy?: string | null,
	): Promise<void>;
}

/**
 * 创建一个 checkpoint store 句柄。
 *
 * @param opts - store 创建选项
 *
 * @example
 * ```ts
 * import { createCheckpointStore } from "@nexus-agent/checkpoint";
 *
 * const store = createCheckpointStore({
 *   cwd: process.cwd(),
 *   sessionId: "session-1",
 *   maxCheckpoints: 64,
 *   maxSizeMb: 256,
 *   swapPolicy: "lru",
 * });
 *
 * const id = await store.create(0, "before-refactor", ["src/main.rs"]);
 * // ... 编辑文件 ...
 * const result = await store.restore(id);
 * ```
 */
export function createCheckpointStore(opts: CheckpointStoreOptions): CheckpointStoreHandle;
