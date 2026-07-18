// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见
// grok-build-main/crates/codegen/xai-grok-workspace/src/session/checkpoint.rs）。
// Nexus Agent 在此基础上重写：移除 xai_hunk_tracker / xai_tool_protocol 依赖，
// 仅保留 FS 维度的 RewindCheckpoint（hunks 字段已删除）。
//
//! 单个 prompt 边界的回滚 checkpoint：FS 快照 + 元数据。
//!
//! 在 Grok 原始设计中，[`RewindCheckpoint`] 还会捆绑 hunk-tracker 增量
//! （`HunkTurnDelta`）和可选的 git HEAD/index 快照。Nexus 移植版本剥离了
//! 这些维度，只保留文件系统层（与 [`crate::file_state`] 对应），因为：
//!
//! - hunk-tracker 是 Grok 内部增量追踪，依赖 `xai_hunk_tracker` 与 omp 的
//!   编辑模型耦合过深，不在 M3 范围内。
//! - git HEAD/index 快照可通过 omp 已有的 git 工具链实现，不必下沉到本 crate。
//!
//! 因此本模块仅提供 `RewindCheckpoint` 类型本身，restore 流程复用
//! [`crate::file_state::rewind_files`]。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::file_state::{FileRewindResponse, RewindPoint};

/// 一个 prompt 边界的回滚 checkpoint：FS 快照 + 元数据。
///
/// 与 Grok 版本相比，删除了 `hunks: Option<HunkTurnDelta>` 字段（无外部依赖），
/// 增加 `label` 与 `created_at` 字段供 TS 侧的 picker 显示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewindCheckpoint {
    /// 该 checkpoint 所属的 prompt 索引（0-based，单调递增）。
    pub prompt_index: usize,
    /// 用户可读的标签（例如 "before-refactor"）；可为空。
    #[serde(default)]
    pub label: String,
    /// 创建时刻。
    pub created_at: DateTime<Utc>,
    /// 文件系统 before/after 快照。
    pub fs: RewindPoint,
}

impl RewindCheckpoint {
    /// 用 prompt_index + label 创建一个新的 checkpoint（fs 为空 RewindPoint）。
    pub fn new(prompt_index: usize, label: impl Into<String>) -> Self {
        Self {
            prompt_index,
            label: label.into(),
            created_at: Utc::now(),
            fs: RewindPoint::new(prompt_index),
        }
    }

    /// 从一个已存在的 RewindPoint 构建 checkpoint（保留其 prompt_index）。
    pub fn from_rewind_point(point: RewindPoint, label: impl Into<String>) -> Self {
        let prompt_index = point.prompt_index;
        Self {
            prompt_index,
            label: label.into(),
            created_at: point.created_at,
            fs: point,
        }
    }
}

/// Re-export：将文件回滚到 `target_prompt_index` 之前的状态。
///
/// 详见 [`crate::file_state::rewind_files`]。本 re-export 保持 Grok 原始
/// 模块路径 `checkpoint::rewind_files` 的导出形态，便于上层调用方迁移。
pub use crate::file_state::rewind_files as restore_fs;

/// Convenience：直接对一个 `RewindCheckpoint` 执行 FS 回滚。
///
/// 等价于调用 [`crate::file_state::rewind_files`]，但接受单个 checkpoint
/// 而非 tracker。返回值与 `rewind_files` 一致。
pub async fn restore_checkpoint_files(
    checkpoint: &RewindCheckpoint,
    cwd: &std::path::Path,
) -> FileRewindResponse {
    let mut reverted_files = Vec::new();
    let mut clean_files = Vec::new();
    let mut conflicts = Vec::new();
    let mut had_errors = false;

    for (flex_path, before_snapshot) in &checkpoint.fs.file_snapshots {
        let abs = flex_path.to_absolute(cwd);
        let current_content = tokio::fs::read_to_string(&abs).await.ok();
        let after_content = checkpoint
            .fs
            .after_snapshots
            .get(flex_path)
            .and_then(|s| s.content.clone());

        if current_content == after_content {
            clean_files.push(flex_path.to_string());
        } else {
            // 不阻断回滚，只记录冲突
            let conflict_type = if current_content.is_none() && after_content.is_some() {
                crate::file_state::ConflictType::DeletedExternally
            } else if current_content.is_some() && after_content.is_none() {
                crate::file_state::ConflictType::CreatedExternally
            } else {
                crate::file_state::ConflictType::ModifiedExternally
            };
            conflicts.push(crate::file_state::FileRewindConflict {
                path: flex_path.to_string(),
                conflict_type,
            });
        }

        match &before_snapshot.content {
            Some(data) => {
                if let Err(e) = tokio::fs::write(&abs, data.as_bytes()).await {
                    tracing::warn!(?flex_path, ?e, "restore_checkpoint_files: 写入失败");
                    had_errors = true;
                    continue;
                }
            }
            None => {
                // before 快照为 None → 文件原本不存在，删除当前文件
                if tokio::fs::metadata(&abs).await.is_ok() {
                    if let Err(e) = tokio::fs::remove_file(&abs).await {
                        tracing::warn!(?flex_path, ?e, "restore_checkpoint_files: 删除失败");
                        had_errors = true;
                        continue;
                    }
                }
            }
        }
        reverted_files.push(flex_path.to_string());
    }

    let error = if had_errors {
        Some("部分文件无法还原".to_string())
    } else {
        None
    };

    FileRewindResponse {
        success: !had_errors,
        target_prompt_index: checkpoint.prompt_index,
        reverted_files,
        clean_files,
        conflicts,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_state::{FileSnapshot, FlexiblePath};
    use std::path::PathBuf;

    #[test]
    fn rewind_checkpoint_new_has_empty_fs() {
        let cp = RewindCheckpoint::new(3, "before-refactor");
        assert_eq!(cp.prompt_index, 3);
        assert_eq!(cp.label, "before-refactor");
        assert!(cp.fs.file_snapshots.is_empty());
        assert!(cp.fs.after_snapshots.is_empty());
    }

    #[test]
    fn rewind_checkpoint_from_rewind_point_preserves_prompt_index() {
        let mut point = RewindPoint::new(7);
        point.add_snapshot(FileSnapshot::new(
            PathBuf::from("a.txt"),
            Some("hello".into()),
        ));
        let cp = RewindCheckpoint::from_rewind_point(point, "snap");
        assert_eq!(cp.prompt_index, 7);
        assert_eq!(cp.label, "snap");
        assert_eq!(cp.fs.file_snapshots.len(), 1);
    }

    #[tokio::test]
    async fn restore_checkpoint_files_writes_back_content() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("a.txt");
        tokio::fs::write(&file, b"v1").await.unwrap();

        let mut point = RewindPoint::new(0);
        let rel = PathBuf::from("a.txt");
        point.add_snapshot(FileSnapshot::new_flexible(
            FlexiblePath::Relative(rel.clone()),
            Some("v0".into()),
        ));
        point.set_after_snapshot(FileSnapshot::new_flexible(
            FlexiblePath::Relative(rel),
            Some("v1".into()),
        ));
        let cp = RewindCheckpoint::from_rewind_point(point, "test");

        let resp = restore_checkpoint_files(&cp, &cwd).await;
        assert!(resp.success, "{:?}", resp.error);
        let restored = tokio::fs::read_to_string(&file).await.unwrap();
        assert_eq!(restored, "v0");
    }

    #[tokio::test]
    async fn restore_checkpoint_files_deletes_newly_created_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("new.txt");
        // agent 创建了文件
        tokio::fs::write(&file, b"created").await.unwrap();

        let mut point = RewindPoint::new(0);
        let rel = PathBuf::from("new.txt");
        // before 快照为 None → 文件原本不存在
        point.add_snapshot(FileSnapshot::new_flexible(
            FlexiblePath::Relative(rel.clone()),
            None,
        ));
        point.set_after_snapshot(FileSnapshot::new_flexible(
            FlexiblePath::Relative(rel),
            Some("created".into()),
        ));
        let cp = RewindCheckpoint::from_rewind_point(point, "test");

        let resp = restore_checkpoint_files(&cp, &cwd).await;
        assert!(resp.success, "{:?}", resp.error);
        assert!(!file.exists(), "新创建的文件应被删除");
    }

    #[test]
    fn rewind_checkpoint_serializes_roundtrip() {
        let mut cp = RewindCheckpoint::new(2, "label");
        cp.fs.add_snapshot(FileSnapshot::new(
            PathBuf::from("a.rs"),
            Some("fn a() {}".into()),
        ));
        let json = serde_json::to_string(&cp).unwrap();
        let back: RewindCheckpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.prompt_index, 2);
        assert_eq!(back.label, "label");
        assert_eq!(back.fs.file_snapshots.len(), 1);
    }
}
