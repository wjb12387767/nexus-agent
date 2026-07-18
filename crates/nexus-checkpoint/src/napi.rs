// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0）。
// Nexus Agent 在此基础上编写 NAPI 绑定，暴露 CheckpointStore 给 TypeScript。
//
//! NAPI 绑定：将 [`CheckpointStore`] 暴露给 TypeScript 侧。
//!
//! 暴露的接口：
//!
//! - [`CheckpointStoreHandle::create`] — 创建 checkpoint
//! - [`CheckpointStoreHandle::restore`] — 回滚到指定 checkpoint
//! - [`CheckpointStoreHandle::list`] — 列出所有 checkpoint 元数据
//! - [`CheckpointStoreHandle::diff`] — 计算两个 checkpoint 之间的差异
//!
//! ## TS 侧使用示例
//!
//! ```ts
//! import { createCheckpointStore } from "@nexus-agent/checkpoint";
//!
//! const store = createCheckpointStore({
//!   cwd: process.cwd(),
//!   sessionId: "session-1",
//!   maxCheckpoints: 64,
//! });
//!
//! const id = await store.create(0, "before-refactor", ["src/main.rs"]);
//! // ... 用户编辑文件 ...
//! const result = await store.restore(id);
//! console.log(result.revertedFiles);
//! ```

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::{module_init, napi};

use crate::checkpoint_store::{CheckpointMeta, CheckpointStore};
use crate::swap_policy::SwapPolicyConfig;

/// Checkpoint store 创建选项。
#[napi(object)]
pub struct CheckpointStoreOptions {
    /// 工作区根目录（cwd）。
    pub cwd: String,
    /// Session ID（用于隔离不同 session 的 checkpoint）。
    pub session_id: String,
    /// 最大保留 checkpoint 数量（默认 64）。
    pub max_checkpoints: Option<u32>,
    /// 最大总字节数（MB，默认 256）。
    pub max_size_mb: Option<u64>,
    /// 驱逐策略（"lru" | "lru-size" | "fifo" | "none"，默认 "lru"）。
    pub swap_policy: Option<String>,
}

/// Checkpoint 元数据（TS 侧）。
#[napi(object)]
pub struct CheckpointMetaDto {
    pub id: u32,
    pub label: String,
    pub created_at: String,
    pub num_files: u32,
    pub size_bytes: u64,
}

/// restore 操作的结果（TS 侧）。
#[napi(object)]
pub struct RestoreResultDto {
    pub success: bool,
    pub target_prompt_index: u32,
    pub reverted_files: Vec<String>,
    pub clean_files: Vec<String>,
    pub conflicts: Vec<FileRewindConflictDto>,
    pub error: Option<String>,
}

/// 单个文件的 rewind 冲突（TS 侧）。
#[napi(object)]
pub struct FileRewindConflictDto {
    pub path: String,
    pub conflict_type: String,
}

/// diff 操作的结果（TS 侧）。
#[napi(object)]
pub struct DiffResultDto {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

/// NAPI 句柄：包装 [`CheckpointStore`]，向 TS 侧暴露 create/restore/list/diff。
#[napi]
pub struct CheckpointStoreHandle {
    inner: CheckpointStore,
}

/// 创建一个 checkpoint store 句柄。
#[napi]
pub fn create_checkpoint_store(opts: CheckpointStoreOptions) -> Result<CheckpointStoreHandle> {
    let cwd = PathBuf::from(&opts.cwd);
    let cap = opts.max_checkpoints.unwrap_or(64) as usize;
    let mut policy_config = match opts.swap_policy.as_deref() {
        Some(s) => SwapPolicyConfig::from_policy_str(s),
        None => SwapPolicyConfig::default(),
    };
    if let Some(max_mb) = opts.max_size_mb {
        policy_config.max_size_bytes = max_mb * 1024 * 1024;
    }
    policy_config.max_checkpoints = cap;

    let store = CheckpointStore::with_cap_and_policy(&cwd, &opts.session_id, cap, policy_config);
    Ok(CheckpointStoreHandle { inner: store })
}

#[napi]
impl CheckpointStoreHandle {
    /// 是否在 reflink-capable 文件系统上（btrfs/apfs 等）。
    #[napi(getter)]
    pub fn reflink_capable(&self) -> bool {
        self.inner.reflink_capable()
    }

    /// 工作区根目录。
    #[napi(getter)]
    pub fn cwd(&self) -> String {
        self.inner.cwd().to_string_lossy().into_owned()
    }

    /// store 目录的绝对路径。
    #[napi(getter)]
    pub fn store_dir(&self) -> String {
        self.inner.dir().to_string_lossy().into_owned()
    }

    /// 当前缓存中的 checkpoint 数量。
    #[napi(getter)]
    pub async fn len(&self) -> u32 {
        self.inner.len().await as u32
    }

    /// 创建一个 checkpoint：捕获 `paths` 的当前快照。
    ///
    /// - `prompt_index`：prompt 索引（0-based，单调递增）
    /// - `label`：用户可读标签
    /// - `paths`：要捕获的文件路径（相对 cwd 或绝对）
    #[napi]
    pub async fn create(
        &self,
        prompt_index: u32,
        label: String,
        paths: Vec<String>,
    ) -> Result<u32> {
        let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        let id = self
            .inner
            .create(prompt_index as usize, &label, &path_bufs)
            .await
            .map_err(|e| Error::from_reason(format!("create checkpoint: {e}")))?;
        Ok(id as u32)
    }

    /// 回滚到指定 checkpoint。
    #[napi]
    pub async fn restore(&self, prompt_id: u32) -> Result<RestoreResultDto> {
        let resp = self.inner.restore(prompt_id as usize).await;
        Ok(RestoreResultDto {
            success: resp.success,
            target_prompt_index: resp.target_prompt_index as u32,
            reverted_files: resp.reverted_files,
            clean_files: resp.clean_files,
            conflicts: resp
                .conflicts
                .into_iter()
                .map(|c| FileRewindConflictDto {
                    path: c.path,
                    conflict_type: match c.conflict_type {
                        crate::file_state::ConflictType::DeletedExternally => {
                            "deleted_externally".to_string()
                        }
                        crate::file_state::ConflictType::CreatedExternally => {
                            "created_externally".to_string()
                        }
                        crate::file_state::ConflictType::ModifiedExternally => {
                            "modified_externally".to_string()
                        }
                    },
                })
                .collect(),
            error: resp.error,
        })
    }

    /// 列出所有 checkpoint 的元数据（按 id 升序）。
    #[napi]
    pub async fn list(&self) -> Result<Vec<CheckpointMetaDto>> {
        let metas: Vec<CheckpointMeta> = self.inner.list().await;
        Ok(metas
            .into_iter()
            .map(|m| CheckpointMetaDto {
                id: m.id as u32,
                label: m.label,
                created_at: m.created_at.to_rfc3339(),
                num_files: m.num_files as u32,
                size_bytes: m.size_bytes,
            })
            .collect())
    }

    /// 计算两个 checkpoint 之间的文件差异。
    #[napi]
    pub async fn diff(&self, from_id: u32, to_id: u32) -> Result<DiffResultDto> {
        let (added, modified, removed) = self
            .inner
            .diff(from_id as usize, to_id as usize)
            .await
            .map_err(|e| Error::from_reason(format!("diff checkpoint: {e}")))?;
        Ok(DiffResultDto {
            added,
            modified,
            removed,
        })
    }

    /// 删除 `>= target` 的所有 checkpoint。
    #[napi]
    pub async fn truncate_from(&self, target: u32) -> Result<()> {
        self.inner.truncate_from(target as usize).await;
        Ok(())
    }

    /// 更新驱逐策略配置。
    #[napi]
    pub async fn update_policy(
        &self,
        max_checkpoints: Option<u32>,
        max_size_mb: Option<u64>,
        swap_policy: Option<String>,
    ) -> Result<()> {
        let mut config = match swap_policy.as_deref() {
            Some(s) => SwapPolicyConfig::from_policy_str(s),
            None => SwapPolicyConfig::default(),
        };
        if let Some(cap) = max_checkpoints {
            config.max_checkpoints = cap as usize;
        }
        if let Some(max_mb) = max_size_mb {
            config.max_size_bytes = max_mb * 1024 * 1024;
        }
        self.inner.update_policy(config).await;
        Ok(())
    }
}

#[module_init]
fn init() {
    // 模块初始化：可在此注册全局日志等
    tracing::debug!("nexus-checkpoint NAPI 模块已加载");
}
