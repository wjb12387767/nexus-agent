/**
 * Nexus Checkpoint — TS 侧入口。
 *
 * 从 native 加载器 re-export 所有绑定。消费者应从包根导入：
 *
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
 * // 在编辑前创建 checkpoint
 * const id = await store.create(0, "before-refactor", ["src/main.rs"]);
 *
 * // ... 用户编辑文件 ...
 *
 * // 回滚到 checkpoint
 * const result = await store.restore(id);
 * console.log(`已还原 ${result.revertedFiles.length} 个文件`);
 * ```
 *
 * ## 平台支持
 *
 * - Linux: btrfs `FICLONE` / overlayfs reflink（O(1) CoW，优先尝试）
 * - macOS: APFS `clonefile(2)` reflink（O(1) CoW，优先尝试）
 * - Windows: 全量拷贝（无 reflink），通过 sha256 去重避免重复存储
 *
 * 在所有平台上，相同内容（sha256 相同）的文件只存储一份
 * （content-addressed blob store），保证磁盘占用 < 工作区大小 1.5×。
 *
 * ## 与 omp 会话级 checkpoint/rewind 的关系
 *
 * omp 已有会话级 `checkpoint`/`rewind` 工具（仅截断对话历史）。
 * 本系统是文件级回滚（真正还原磁盘文件内容），两者互补。
 */

export {
	createCheckpointStore,
	CheckpointStoreHandle,
	type CheckpointStoreOptions,
	type CheckpointMetaDto,
	type RestoreResultDto,
	type DiffResultDto,
	type FileRewindConflictDto,
} from "../native/index.js";
