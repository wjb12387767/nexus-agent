// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-workspace/src/session/{checkpoint,checkpoint_store,file_state,swap_policy}.rs）。
// Nexus Agent 在此基础上重写：移除 xai-grok-config / xai-grok-paths / xai-hunk-tracker
// 依赖，改为直接使用 std::path + sha2 + pi-iso，并暴露 NAPI 接口给 TS 侧。
//
//! 文件系统级 Checkpoint/回滚系统：Nexus Agent 移植自 Grok Build。
//!
//! 本 crate 提供"工作区文件级"快照与回滚能力，与 omp 已有的会话级
//! `checkpoint`/`rewind` 工具（仅截断对话历史）互补：本系统真正还原磁盘
//! 文件内容到快照时刻的状态。
//!
//! ## 核心抽象
//!
//! - [`FileStateTracker`] — 跟踪每个 prompt 边界捕获的文件 before/after 快照
//! - [`RewindPoint`] — 单个 prompt 的文件快照集合
//! - [`CheckpointStore`] — 磁盘镜像 + 内存缓存的双层存储，带 LRU + 大小上限
//! - [`SwapPolicy`] — checkpoint 驱逐策略（LRU + 总字节上限）
//! - [`RewindCheckpoint`] — 持久化的 checkpoint 单元
//!
//! ## 平台支持
//!
//! | 平台     | 快照机制                              | 备注                                       |
//! |---------|--------------------------------------|--------------------------------------------|
//! | Linux   | btrfs `FICLONE` / overlayfs reflink  | O(1) CoW，优先尝试                          |
//! | macOS   | APFS `clonefile(2)` reflink           | O(1) CoW，优先尝试                          |
//! | Windows | 全量拷贝（无 reflink）                  | 文档说明限制；通过 sha2 去重避免重复存储      |
//!
//! 在所有平台上，相同内容（sha256 相同）的文件只存储一份（content-addressed
//! blob store），保证磁盘占用 < 工作区大小 1.5×。
//!
//! ```rust,no_run
//! use nexus_checkpoint::CheckpointStore;
//! use std::path::Path;
//!
//! # tokio_test::block_on(async {
//! let cwd = Path::new("/home/user/project");
//! let store = CheckpointStore::new(cwd, "session-1");
//! let id = store.create("before-refactor").await.unwrap();
//! // ... 用户编辑文件 ...
//! store.restore(id).await.unwrap();
//! # });
//! ```

pub mod checkpoint;
pub mod checkpoint_store;
pub mod file_state;
pub mod napi;
pub mod swap_policy;

pub use checkpoint::{restore_checkpoint_files, restore_fs, RewindCheckpoint};
pub use checkpoint_store::{CheckpointStore, CheckpointId, CheckpointMeta};
pub use file_state::{
    ConflictType, FileHashMemo, FileRewindConflict, FileRewindResponse, FileSnapshot,
    FileStateTracker, FlexiblePath, RewindPoint, RewindPointMeta,
};
pub use swap_policy::{EvictionReason, SwapDecision, SwapPolicy, SwapPolicyConfig};
