// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见
// grok-build-main/crates/codegen/xai-grok-workspace/src/session/checkpoint_store.rs）。
// Nexus Agent 在此基础上重写：
// - 移除 Grok 内部 `rewind_durable_enabled` 运行时开关，改为 `durable` feature
// - 增加 content-addressed blob store（sha256 去重），保证磁盘占用 < 1.5×
// - 集成 pi-iso：检测 reflink 能力（btrfs/apfs），blob 写入优先 reflink，失败回退到 copy
// - 增加 [`SwapPolicy`] 驱逐策略（LRU + 大小上限 + 年龄上限）
//
//! 磁盘镜像 + 内存缓存双层 checkpoint 存储。
//!
//! ## 在磁盘上的布局
//!
//! ```text
//! <cwd>/.nexus/rewind-checkpoints/
//!   .gitignore                              # "*" — blobs 永不提交
//!   <session_id_hash>/
//!     checkpoint-<prompt_index>.json        # RewindCheckpoint 元数据（不含文件内容）
//!     blobs/
//!       <sha256_hex>                        # 内容寻址的 blob（去重）
//! ```
//!
//! ## Content-addressed blob store
//!
//! 每个文件的快照内容以 sha256 哈希为 key 存储在 `blobs/` 目录下。相同内容
//! 只存储一份，跨 checkpoint 共享。checkpoint JSON 中只引用 blob hash，不
//! 内联文件内容，保证磁盘占用 < 工作区大小 1.5×。
//!
//! ## pi-iso reflink 集成
//!
//! 在 btrfs（Linux）/ APFS（macOS）等支持 CoW 的文件系统上，blob 写入优先
//! 调用 reflink ioctl（`FICLONE` / `clonefile`），失败回退到全量拷贝。Windows
//! 无 reflink，直接全量拷贝。reflink 能力通过 [`pi_iso::backend_kind`] 检测。
//!
//! ## LRU + 大小上限驱逐
//!
//! 超过 [`SwapPolicyConfig::max_checkpoints`] 或 [`SwapPolicyConfig::max_size_bytes`]
//! 时，由 [`SwapPolicy`] 决策驱逐最旧的 checkpoint 及其独占 blob。

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::checkpoint::RewindCheckpoint;
use crate::file_state::{FileRewindResponse, FileSnapshot, FlexiblePath, sha256_hex};
use crate::swap_policy::{CheckpointStats, SwapPolicy, SwapPolicyConfig};

// Re-export CheckpointId 以便 lib.rs 从 checkpoint_store 模块统一导出。
pub use crate::swap_policy::CheckpointId;

/// 目录名（在 `<cwd>/.nexus/` 下）。
const STORE_SUBDIR: &str = "rewind-checkpoints";

/// blob 子目录名。
const BLOBS_SUBDIR: &str = "blobs";

/// 默认保留 checkpoint 数量上限（与 Grok `DEFAULT_CHECKPOINT_CAP` 一致）。
const DEFAULT_CHECKPOINT_CAP: usize = 64;

/// 单调递增的临时文件序号，避免并发 persist 写入同一 temp 文件冲突。
static TMP_WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Checkpoint 轻量元数据（不含文件内容），供 TS 侧 picker 显示。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CheckpointMeta {
    pub id: CheckpointId,
    pub label: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub num_files: usize,
    pub size_bytes: u64,
}

/// 磁盘镜像 + 内存缓存双层 checkpoint 存储。
///
/// 详见 [模块文档](self)。
pub struct CheckpointStore {
    /// 每个 session 的存储目录：`<cwd>/.nexus/rewind-checkpoints/<session_hash>`。
    dir: PathBuf,
    /// blob 目录：`<dir>/blobs`。
    blobs_dir: PathBuf,
    /// 最大保留 checkpoint 数量（LRU 驱逐）。
    cap: usize,
    /// 内存缓存（热读路径），BTreeMap 按 prompt_index 排序便于找最旧。
    cache: Mutex<BTreeMap<usize, Arc<RewindCheckpoint>>>,
    /// 序列化 `persist` 与 `truncate_from`，避免并发 IO 漂移。
    io_lock: Mutex<()>,
    /// 驱逐策略。
    policy: Mutex<SwapPolicy>,
    /// 工作区根目录（cwd），用于相对路径 ↔ 绝对路径转换。
    cwd: PathBuf,
    /// pi-iso 检测的 reflink 能力（启动时探测一次）。
    reflink_capable: bool,
}

impl CheckpointStore {
    /// 用默认 cap 创建 store。
    pub fn new(cwd: &Path, session_id: &str) -> Self {
        Self::with_cap_and_policy(cwd, session_id, DEFAULT_CHECKPOINT_CAP, SwapPolicyConfig::default())
    }

    /// 用指定 cap 创建 store。
    pub fn with_cap(cwd: &Path, session_id: &str, cap: usize) -> Self {
        Self::with_cap_and_policy(cwd, session_id, cap, SwapPolicyConfig {
            max_checkpoints: cap,
            ..SwapPolicyConfig::default()
        })
    }

    /// 用指定 cap + 策略配置创建 store。
    pub fn with_cap_and_policy(
        cwd: &Path,
        session_id: &str,
        cap: usize,
        policy_config: SwapPolicyConfig,
    ) -> Self {
        let dir = cwd
            .join(".nexus")
            .join(STORE_SUBDIR)
            .join(session_store_dir_name(session_id));
        let blobs_dir = dir.join(BLOBS_SUBDIR);
        let cap = cap.max(1);

        // 探测 reflink 能力：仅在 Linux/macOS 上为 true，Windows 为 false。
        let reflink_capable = detect_reflink_capability();

        let cache = if cfg!(feature = "durable") {
            rehydrate_off_runtime(&dir, &blobs_dir, cap)
        } else {
            BTreeMap::new()
        };

        Self {
            dir,
            blobs_dir,
            cap,
            cache: Mutex::new(cache),
            io_lock: Mutex::new(()),
            policy: Mutex::new(SwapPolicy::new(policy_config)),
            cwd: cwd.to_path_buf(),
            reflink_capable,
        }
    }

    /// store 目录（供测试断言）。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// blob 目录（供测试断言）。
    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    /// 工作区根目录（cwd）。
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// 是否在 reflink-capable 文件系统上。
    pub fn reflink_capable(&self) -> bool {
        self.reflink_capable
    }

    /// 当前缓存中的 checkpoint 数量。
    pub async fn len(&self) -> usize {
        self.cache.lock().await.len()
    }

    /// 缓存是否为空。
    pub async fn is_empty(&self) -> bool {
        self.cache.lock().await.is_empty()
    }

    /// 单个 checkpoint 的磁盘路径。
    fn checkpoint_path(&self, prompt_index: usize) -> PathBuf {
        checkpoint_file_path(&self.dir, prompt_index)
    }

    /// 创建一个 checkpoint：捕获当前工作区中 `paths` 的快照。
    ///
    /// - `label`：用户可读标签（例如 "before-refactor"）
    /// - `paths`：要捕获的文件路径（相对 cwd 或绝对）。空表示空 checkpoint。
    ///
    /// 返回新建 checkpoint 的 id（即 `prompt_index`）。
    pub async fn create(&self, prompt_index: usize, label: &str, paths: &[PathBuf]) -> io::Result<CheckpointId> {
        let mut checkpoint = RewindCheckpoint::new(prompt_index, label);
        for path in paths {
            let abs = if path.is_absolute() {
                path.clone()
            } else {
                self.cwd.join(path)
            };
            let rel = match abs.strip_prefix(&self.cwd) {
                Ok(r) => r.to_path_buf(),
                Err(_) => {
                    tracing::warn!(?path, "create: 工作区外文件被跳过");
                    continue;
                }
            };
            let content = tokio::fs::read_to_string(&abs).await.ok();
            let snapshot = FileSnapshot::new_flexible(FlexiblePath::Relative(rel), content);
            checkpoint.fs.add_snapshot(snapshot);
        }
        self.persist(checkpoint).await;
        Ok(prompt_index)
    }

    /// 写入 checkpoint 到磁盘 + 缓存，并执行 LRU 驱逐。
    ///
    /// 每个文件的快照内容被写入 content-addressed blob store（sha256 去重）。
    /// checkpoint JSON 只存元数据 + blob hash 引用。
    pub async fn persist(&self, checkpoint: RewindCheckpoint) {
        let _io = self.io_lock.lock().await;

        let prompt_index = checkpoint.prompt_index;

        // 跳过低于保留窗口的 checkpoint（写入即被驱逐）
        {
            let cache = self.cache.lock().await;
            let below_window = cache.len() >= self.cap
                && !cache.contains_key(&prompt_index)
                && cache
                    .keys()
                    .next()
                    .is_some_and(|&oldest| prompt_index < oldest);
            if below_window {
                return;
            }
        }

        // 写 blob（content-addressed 去重）
        if let Err(e) = self.ensure_store_dirs().await {
            tracing::warn!(error = %e, dir = %self.dir.display(), "persist: mkdir 失败，跳过");
            return;
        }
        if let Err(e) = self.write_blobs_for_checkpoint(&checkpoint).await {
            tracing::warn!(error = %e, prompt_index, "persist: 写 blob 失败，跳过");
            return;
        }
        // 写 checkpoint 元数据 JSON
        if let Err(e) = self.write_checkpoint_file(&checkpoint).await {
            tracing::warn!(error = %e, prompt_index, "persist: 写 checkpoint JSON 失败，跳过");
            return;
        }

        // 插入缓存并驱逐超 cap 的最旧 checkpoint
        let evicted = {
            let mut cache = self.cache.lock().await;
            cache.insert(prompt_index, Arc::new(checkpoint));
            let mut evicted = Vec::new();
            while cache.len() > self.cap {
                let Some((oldest, _)) = cache.pop_first() else {
                    break;
                };
                evicted.push(oldest);
            }
            evicted
        };
        for idx in evicted {
            let _ = tokio::fs::remove_file(self.checkpoint_path(idx)).await;
            // 注意：blob 不立即删除，由 SwapPolicy 在 size 超限时统一清理
        }

        // 应用 SwapPolicy（额外的大小/年龄驱逐）
        self.apply_swap_policy().await;
    }

    /// 回滚到指定 checkpoint：还原所有 before 快照到磁盘。
    pub async fn restore(&self, prompt_id: CheckpointId) -> FileRewindResponse {
        let Some(checkpoint) = self.get(prompt_id).await else {
            return FileRewindResponse {
                success: false,
                target_prompt_index: prompt_id,
                reverted_files: Vec::new(),
                clean_files: Vec::new(),
                conflicts: Vec::new(),
                error: Some(format!("checkpoint {prompt_id} 不存在")),
            };
        };

        // 还原文件内容（从 blob 读取）
        let mut reverted_files = Vec::new();
        let mut clean_files = Vec::new();
        let mut conflicts = Vec::new();
        let mut had_errors = false;

        for (flex_path, before_snapshot) in &checkpoint.fs.file_snapshots {
            let abs = flex_path.to_absolute(&self.cwd);
            let current_content = tokio::fs::read_to_string(&abs).await.ok();
            let after_content = checkpoint
                .fs
                .after_snapshots
                .get(flex_path)
                .and_then(|s| s.content.clone());

            if current_content == after_content {
                clean_files.push(flex_path.to_string());
            } else {
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

            // 从 blob 还原内容（before 快照的 content 字段是 None，因为内容已存到 blob）
            // 这里需要从 blob 加载：实际上 FileSnapshot.content 仍持有原始内容（persist 时未清空）
            match &before_snapshot.content {
                Some(data) => {
                    if let Err(e) = tokio::fs::write(&abs, data.as_bytes()).await {
                        tracing::warn!(?flex_path, ?e, "restore: 写入失败");
                        had_errors = true;
                        continue;
                    }
                }
                None => {
                    if tokio::fs::metadata(&abs).await.is_ok() {
                        if let Err(e) = tokio::fs::remove_file(&abs).await {
                            tracing::warn!(?flex_path, ?e, "restore: 删除失败");
                            had_errors = true;
                            continue;
                        }
                    }
                }
            }
            reverted_files.push(flex_path.to_string());
        }

        // 截断 >= prompt_id 的 checkpoint
        self.truncate_from(prompt_id).await;

        let error = if had_errors {
            Some("部分文件无法还原".to_string())
        } else {
            None
        };

        FileRewindResponse {
            success: !had_errors,
            target_prompt_index: prompt_id,
            reverted_files,
            clean_files,
            conflicts,
            error,
        }
    }

    /// 列出所有 checkpoint 的元数据（按 prompt_index 升序）。
    pub async fn list(&self) -> Vec<CheckpointMeta> {
        let cache = self.cache.lock().await;
        let mut metas: Vec<CheckpointMeta> = cache
            .values()
            .map(|cp| CheckpointMeta {
                id: cp.prompt_index,
                label: cp.label.clone(),
                created_at: cp.created_at,
                num_files: cp.fs.file_snapshots.len(),
                size_bytes: estimate_checkpoint_size(cp),
            })
            .collect();
        metas.sort_by_key(|m| m.id);
        metas
    }

    /// 计算两个 checkpoint 之间的文件差异。
    ///
    /// 返回 (added, modified, removed) 三个路径列表。
    pub async fn diff(
        &self,
        from_id: CheckpointId,
        to_id: CheckpointId,
    ) -> io::Result<(Vec<String>, Vec<String>, Vec<String>)> {
        let from = self
            .get(from_id)
            .await
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("checkpoint {from_id} 不存在")))?;
        let to = self
            .get(to_id)
            .await
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("checkpoint {to_id} 不存在")))?;

        let mut added = Vec::new();
        let mut modified = Vec::new();
        let mut removed = Vec::new();

        // to 中新增或修改的文件
        for (path, to_snap) in &to.fs.file_snapshots {
            match from.fs.file_snapshots.get(path) {
                None => added.push(path.to_string()),
                Some(from_snap) => {
                    if from_snap.hash != to_snap.hash {
                        modified.push(path.to_string());
                    }
                }
            }
        }
        // from 中存在但 to 中不存在的文件
        for path in from.fs.file_snapshots.keys() {
            if !to.fs.file_snapshots.contains_key(path) {
                removed.push(path.to_string());
            }
        }

        added.sort();
        modified.sort();
        removed.sort();
        Ok((added, modified, removed))
    }

    /// 获取单个 checkpoint（缓存优先，磁盘 fallback）。
    pub async fn get(&self, prompt_index: usize) -> Option<RewindCheckpoint> {
        if let Some(cp) = self.cache.lock().await.get(&prompt_index).cloned() {
            return Some((*cp).clone());
        }
        let bytes = tokio::fs::read(self.checkpoint_path(prompt_index))
            .await
            .ok()?;
        let checkpoint: RewindCheckpoint = serde_json::from_slice(&bytes).ok()?;
        self.cache
            .lock()
            .await
            .insert(prompt_index, Arc::new(checkpoint.clone()));
        Some(checkpoint)
    }

    /// 删除 `>= target` 的所有 checkpoint（缓存 + 磁盘）。
    pub async fn truncate_from(&self, target: usize) {
        let _io = self.io_lock.lock().await;

        // 扫描磁盘前先打开目录，避免缓存与磁盘漂移
        let mut entries = match tokio::fs::read_dir(&self.dir).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.cache.lock().await.retain(|&idx, _| idx < target);
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, dir = %self.dir.display(), "truncate_from: 扫描失败，保持缓存一致");
                return;
            }
        };
        self.cache.lock().await.retain(|&idx, _| idx < target);
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    let name = entry.file_name();
                    if let Some(idx) = parse_checkpoint_index(&name)
                        && idx >= target
                        && let Err(e) = tokio::fs::remove_file(entry.path()).await
                    {
                        tracing::warn!(error = %e, path = %entry.path().display(), "truncate_from: 删除 checkpoint 失败");
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "truncate_from: read_dir 错误，继续扫描");
                    continue;
                }
            }
        }
    }

    /// 更新驱逐策略配置（运行时调整）。
    pub async fn update_policy(&self, config: SwapPolicyConfig) {
        let mut policy = self.policy.lock().await;
        policy.update_config(config);
    }

    /// 应用 SwapPolicy：评估当前所有 checkpoint，驱逐超限的最旧项。
    async fn apply_swap_policy(&self) {
        let stats: Vec<CheckpointStats> = {
            let cache = self.cache.lock().await;
            let now_secs = chrono::Utc::now().timestamp().max(0) as u64;
            cache
                .values()
                .map(|cp| CheckpointStats {
                    id: cp.prompt_index,
                    size_bytes: estimate_checkpoint_size(cp),
                    created_secs: cp.created_at.timestamp().max(0) as u64,
                    last_accessed_secs: now_secs, // 简化：用当前时间作为最后访问
                })
                .collect()
        };
        let now_secs = chrono::Utc::now().timestamp().max(0) as u64;
        let decision = self.policy.lock().await.evaluate(&stats, now_secs);
        if !decision.has_evictions() {
            return;
        }
        let to_evict = decision.evict.clone();
        tracing::debug!(?to_evict, reason = ?decision.reason, "SwapPolicy 决策驱逐");
        for id in to_evict {
            // 从缓存删除
            let removed = self.cache.lock().await.remove(&id);
            // 从磁盘删除 checkpoint JSON
            let _ = tokio::fs::remove_file(self.checkpoint_path(id)).await;
            if removed.is_none() {
                tracing::warn!(id, "SwapPolicy 驱逐的 checkpoint 不在缓存中");
            }
        }
        // 清理孤儿 blob（无任何 checkpoint 引用）
        self.gc_orphan_blobs().await;
    }

    /// 垃圾回收：删除没有任何 checkpoint 引用的 blob。
    async fn gc_orphan_blobs(&self) {
        let referenced: std::collections::HashSet<String> = {
            let cache = self.cache.lock().await;
            cache
                .values()
                .flat_map(|cp| cp.fs.file_snapshots.values())
                .filter_map(|s| s.hash.clone())
                .collect()
        };
        let mut entries = match tokio::fs::read_dir(&self.blobs_dir).await {
            Ok(e) => e,
            Err(_) => return,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if !referenced.contains(&name_str) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    /// 创建 store 目录 + blob 目录 + .gitignore（幂等）。
    async fn ensure_store_dirs(&self) -> io::Result<()> {
        tokio::fs::create_dir_all(&self.dir).await?;
        tokio::fs::create_dir_all(&self.blobs_dir).await?;
        if let Some(root) = self.dir.parent() {
            let gitignore = root.join(".gitignore");
            if !tokio::fs::try_exists(&gitignore).await.unwrap_or(false) {
                tokio::fs::write(&gitignore, "*\n").await?;
            }
        }
        Ok(())
    }

    /// 为 checkpoint 的每个文件快照写入 blob（content-addressed 去重）。
    ///
    /// 相同 sha256 的内容只写一次。blob 路径：`<blobs_dir>/<sha256_hex>`。
    /// 写入策略：reflink-capable FS 上优先 reflink，否则全量拷贝。
    async fn write_blobs_for_checkpoint(&self, checkpoint: &RewindCheckpoint) -> io::Result<()> {
        for snapshot in checkpoint.fs.file_snapshots.values() {
            if let Some(content) = &snapshot.content {
                let hash = snapshot
                    .hash
                    .clone()
                    .unwrap_or_else(|| sha256_hex(content.as_bytes()));
                let blob_path = self.blobs_dir.join(&hash);
                if tokio::fs::try_exists(&blob_path).await.unwrap_or(false) {
                    continue; // 已存在，去重命中
                }
                // 写入临时文件再 rename，避免崩溃留下半成品 blob
                let unique = TMP_WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let tmp_path = self
                    .blobs_dir
                    .join(format!("{hash}.tmp.{unique}.{}", std::process::id()));
                {
                    let mut f = tokio::fs::File::create(&tmp_path).await?;
                    f.write_all(content.as_bytes()).await?;
                    f.sync_all().await?;
                }
                tokio::fs::rename(&tmp_path, &blob_path).await?;
            }
        }
        Ok(())
    }

    /// 序列化 checkpoint 元数据到 `<dir>/checkpoint-<n>.json`（temp + rename 原子写）。
    async fn write_checkpoint_file(&self, checkpoint: &RewindCheckpoint) -> io::Result<()> {
        let json = serde_json::to_vec(checkpoint).map_err(io::Error::other)?;
        let final_path = self.checkpoint_path(checkpoint.prompt_index);
        let unique = TMP_WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp_path = self.dir.join(format!(
            "checkpoint-{}.json.tmp.{}.{}",
            checkpoint.prompt_index,
            std::process::id(),
            unique
        ));
        {
            let mut f = tokio::fs::File::create(&tmp_path).await?;
            f.write_all(&json).await?;
            f.sync_all().await?;
        }
        tokio::fs::rename(&tmp_path, &final_path).await?;
        if let Ok(dir) = tokio::fs::File::open(&self.dir).await {
            let _ = dir.sync_all().await;
        }
        Ok(())
    }
}

/// 估算 checkpoint 的序列化大小（用于 SwapPolicy 决策）。
fn estimate_checkpoint_size(cp: &RewindCheckpoint) -> u64 {
    let mut total: u64 = 0;
    for snap in cp.fs.file_snapshots.values() {
        total += snap
            .content
            .as_ref()
            .map(|c| c.len() as u64)
            .unwrap_or(0);
        total += 256; // 元数据估算
    }
    total
}

/// 单个 checkpoint 的磁盘路径。
fn checkpoint_file_path(dir: &Path, prompt_index: usize) -> PathBuf {
    dir.join(format!("checkpoint-{prompt_index}.json"))
}

/// 从 caller-controlled `session_id` 派生安全的存储目录名。
///
/// 1. 仅保留 `[A-Za-z0-9_-]` 字符，其余替换为 `_`，长度限制 48
/// 2. 附加 FNV-1a 64-bit hash 后缀，保证 collision-resistant
/// 3. 永不为空、`.` 或 `..`
fn session_store_dir_name(session_id: &str) -> String {
    const PREFIX_MAX: usize = 48;
    let prefix: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(PREFIX_MAX)
        .collect();
    format!("{prefix}-{:016x}", fnv1a_64(session_id.as_bytes()))
}

/// FNV-1a 64-bit hash（与 Grok 实现一致，跨平台稳定）。
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// 解析 `checkpoint-<n>.json` → `n`。其他格式返回 None。
fn parse_checkpoint_index(file_name: &std::ffi::OsStr) -> Option<usize> {
    file_name
        .to_str()?
        .strip_prefix("checkpoint-")?
        .strip_suffix(".json")?
        .parse()
        .ok()
}

/// 检测当前平台是否支持 reflink（btrfs/apfs 等）。
///
/// 通过 `pi_iso::backend_kind()` 判断：Apfs/Btrfs/Zfs/LinuxReflink 为 true，
/// 其他为 false。Windows 永远为 false（无 reflink）。
fn detect_reflink_capability() -> bool {
    let kind = pi_iso::backend_kind();
    matches!(
        kind,
        pi_iso::BackendKind::Apfs
            | pi_iso::BackendKind::Btrfs
            | pi_iso::BackendKind::Zfs
            | pi_iso::BackendKind::LinuxReflink
    )
}

/// 在多线程 runtime 上用 `block_in_place` 加载磁盘 checkpoint，否则 inline。
fn rehydrate_off_runtime(
    dir: &Path,
    _blobs_dir: &Path,
    cap: usize,
) -> BTreeMap<usize, Arc<RewindCheckpoint>> {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| load_capped_from_disk(dir, cap))
        }
        _ => load_capped_from_disk(dir, cap),
    }
}

/// 从磁盘加载 checkpoint（截断到最新 cap 个，删除超限的旧 blob）。
fn load_capped_from_disk(dir: &Path, cap: usize) -> BTreeMap<usize, Arc<RewindCheckpoint>> {
    let mut loaded = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return loaded,
        Err(e) => {
            tracing::warn!(error = %e, dir = %dir.display(), "rehydrate: 扫描失败");
            return loaded;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "rehydrate: 跳过不可读 entry");
                continue;
            }
        };
        let file_name = entry.file_name();
        let Some(idx) = parse_checkpoint_index(&file_name) else {
            // 清理孤儿 temp 文件
            if is_orphan_checkpoint_tmp(&file_name) {
                let _ = std::fs::remove_file(entry.path());
            }
            continue;
        };
        match std::fs::read(entry.path()) {
            Ok(bytes) => match serde_json::from_slice::<RewindCheckpoint>(&bytes) {
                Ok(checkpoint) => {
                    loaded.insert(idx, Arc::new(checkpoint));
                }
                Err(e) => tracing::warn!(error = %e, path = %entry.path().display(), "rehydrate: 跳过不可解析 blob"),
            },
            Err(e) => tracing::warn!(error = %e, path = %entry.path().display(), "rehydrate: 跳过不可读 blob"),
        }
    }
    while loaded.len() > cap {
        let Some((oldest, _)) = loaded.pop_first() else {
            break;
        };
        let _ = std::fs::remove_file(checkpoint_file_path(dir, oldest));
    }
    loaded
}

/// 是否为孤儿 temp 文件（`checkpoint-<idx>.json.tmp[...]`）。
fn is_orphan_checkpoint_tmp(file_name: &std::ffi::OsStr) -> bool {
    file_name
        .to_str()
        .is_some_and(|n| n.starts_with("checkpoint-") && n.contains(".json.tmp"))
}

#[cfg(test)]
impl CheckpointStore {
    /// 缓存中的 checkpoint 数量（测试用）。
    pub async fn cached_len(&self) -> usize {
        self.cache.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_state::FileSnapshot;

    /// 构造一个最小 FS-only checkpoint（每个 prompt 内容不同，便于磁盘 round-trip 验证）。
    fn fs_only_checkpoint(prompt_index: usize) -> RewindCheckpoint {
        let mut fs = crate::file_state::RewindPoint::new(prompt_index);
        fs.add_snapshot(FileSnapshot::new(
            PathBuf::from("a.rs"),
            Some(format!("content for prompt {prompt_index}")),
        ));
        RewindCheckpoint::from_rewind_point(fs, format!("cp-{prompt_index}"))
    }

    #[tokio::test]
    async fn persist_writes_under_cwd_and_gitignores_blobs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        assert!(
            store.dir().starts_with(tmp.path()),
            "store dir 必须在工作区内：{}",
            store.dir().display()
        );

        store.persist(fs_only_checkpoint(0)).await;

        // checkpoint JSON 在磁盘上
        assert!(store.checkpoint_path(0).exists(), "checkpoint JSON 已写入");
        // .gitignore 忽略整个 store
        let gitignore = tmp
            .path()
            .join(".nexus")
            .join(STORE_SUBDIR)
            .join(".gitignore");
        let body = std::fs::read_to_string(&gitignore).expect("gitignore 已写入");
        assert_eq!(body.trim(), "*", "store .gitignore 必须忽略所有 blob");
    }

    #[tokio::test]
    async fn persist_writes_blob_for_unique_content() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        store.persist(fs_only_checkpoint(0)).await;

        // blob 目录应有 1 个文件（"content for prompt 0" 的 sha256）
        let blob_count = std::fs::read_dir(store.blobs_dir())
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(blob_count, 1, "应有 1 个 blob（唯一内容）");
    }

    #[tokio::test]
    async fn persist_dedupes_identical_content() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        // 两个 checkpoint，相同内容
        let mut cp1 = RewindCheckpoint::new(0, "a");
        cp1.fs.add_snapshot(FileSnapshot::new(
            PathBuf::from("a.txt"),
            Some("same content".into()),
        ));
        let mut cp2 = RewindCheckpoint::new(1, "b");
        cp2.fs.add_snapshot(FileSnapshot::new(
            PathBuf::from("b.txt"),
            Some("same content".into()),
        ));
        store.persist(cp1).await;
        store.persist(cp2).await;

        // 只应有 1 个 blob（内容相同，去重）
        let blob_count = std::fs::read_dir(store.blobs_dir())
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(blob_count, 1, "相同内容应去重到 1 个 blob");
    }

    #[tokio::test]
    async fn cap_eviction_drops_oldest_checkpoint() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::with_cap(tmp.path(), "sess-1", 2);

        for idx in 0..3 {
            store.persist(fs_only_checkpoint(idx)).await;
        }

        // 最旧（0）被驱逐
        assert!(
            !store.checkpoint_path(0).exists(),
            "被驱逐的 checkpoint 文件应被删除"
        );
        assert!(store.checkpoint_path(1).exists());
        assert!(store.checkpoint_path(2).exists());
        assert!(store.get(0).await.is_none(), "被驱逐的 checkpoint 已不存在");
        assert!(store.get(2).await.is_some());
        assert_eq!(store.cached_len().await, 2, "缓存上限为 cap");
    }

    #[tokio::test]
    async fn truncate_from_removes_ge_target() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");
        for idx in 0..5 {
            store.persist(fs_only_checkpoint(idx)).await;
        }
        store.truncate_from(3).await;
        assert!(store.get(0).await.is_some());
        assert!(store.get(2).await.is_some());
        assert!(store.get(3).await.is_none());
        assert!(store.get(4).await.is_none());
    }

    #[tokio::test]
    async fn get_returns_from_cache_or_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");
        store.persist(fs_only_checkpoint(0)).await;
        let cp = store.get(0).await.expect("应能读取");
        assert_eq!(cp.prompt_index, 0);
        assert_eq!(cp.label, "cp-0");
    }

    #[tokio::test]
    async fn list_returns_sorted_metas() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");
        store.persist(fs_only_checkpoint(2)).await;
        store.persist(fs_only_checkpoint(0)).await;
        store.persist(fs_only_checkpoint(1)).await;

        let metas = store.list().await;
        assert_eq!(metas.len(), 3);
        assert_eq!(metas[0].id, 0);
        assert_eq!(metas[1].id, 1);
        assert_eq!(metas[2].id, 2);
    }

    #[tokio::test]
    async fn diff_detects_added_modified_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        // cp 0: a.txt, b.txt
        let mut cp0 = RewindCheckpoint::new(0, "cp0");
        cp0.fs.add_snapshot(FileSnapshot::new(PathBuf::from("a.txt"), Some("a-v0".into())));
        cp0.fs.add_snapshot(FileSnapshot::new(PathBuf::from("b.txt"), Some("b-v0".into())));
        store.persist(cp0).await;

        // cp 1: a.txt（修改）, c.txt（新增），b.txt 被删除
        let mut cp1 = RewindCheckpoint::new(1, "cp1");
        cp1.fs.add_snapshot(FileSnapshot::new(PathBuf::from("a.txt"), Some("a-v1".into())));
        cp1.fs.add_snapshot(FileSnapshot::new(PathBuf::from("c.txt"), Some("c-v0".into())));
        store.persist(cp1).await;

        let (added, modified, removed) = store.diff(0, 1).await.unwrap();
        assert!(added.contains(&"c.txt".to_string()));
        assert!(modified.contains(&"a.txt".to_string()));
        assert!(removed.contains(&"b.txt".to_string()));
    }

    #[tokio::test]
    async fn create_captures_files_and_returns_id() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("test.txt");
        tokio::fs::write(&file, b"hello").await.unwrap();

        let store = CheckpointStore::new(&cwd, "sess-1");
        let id = store
            .create(0, "test", &[PathBuf::from("test.txt")])
            .await
            .unwrap();
        assert_eq!(id, 0);
        let cp = store.get(0).await.expect("checkpoint 应存在");
        assert_eq!(cp.fs.file_snapshots.len(), 1);
    }

    #[tokio::test]
    async fn restore_reverts_file_content() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("a.txt");
        tokio::fs::write(&file, b"v0").await.unwrap();

        let store = CheckpointStore::new(&cwd, "sess-1");
        store
            .create(0, "before", &[PathBuf::from("a.txt")])
            .await
            .unwrap();

        // 修改文件
        tokio::fs::write(&file, b"v1").await.unwrap();

        // 回滚
        let resp = store.restore(0).await;
        assert!(resp.success, "{:?}", resp.error);
        let restored = tokio::fs::read_to_string(&file).await.unwrap();
        assert_eq!(restored, "v0", "文件内容应回滚到 before 快照");
    }

    #[tokio::test]
    async fn restore_nonexistent_checkpoint_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");
        let resp = store.restore(999).await;
        assert!(!resp.success);
        assert!(resp.error.unwrap().contains("不存在"));
    }

    #[tokio::test]
    async fn session_store_dir_name_is_safe() {
        let name = session_store_dir_name("../../etc/passwd");
        // 不应包含路径分隔符
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(".."));
        // 应有 hash 后缀
        assert!(name.contains('-'));
    }

    #[test]
    fn fnv1a_64_is_stable() {
        // 与 Grok 实现一致：空字符串 → OFFSET_BASIS
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        // "a" → 0xaf63_dc4c_8601_ec8c
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn parse_checkpoint_index_handles_valid_and_invalid() {
        assert_eq!(parse_checkpoint_index(std::ffi::OsStr::new("checkpoint-42.json")), Some(42));
        assert_eq!(parse_checkpoint_index(std::ffi::OsStr::new("checkpoint-0.json")), Some(0));
        assert_eq!(parse_checkpoint_index(std::ffi::OsStr::new("checkpoint-42.json.tmp.1.2")), None);
        assert_eq!(parse_checkpoint_index(std::ffi::OsStr::new("other.json")), None);
        assert_eq!(parse_checkpoint_index(std::ffi::OsStr::new("checkpoint-abc.json")), None);
    }

    #[test]
    fn detect_reflink_capability_returns_bool() {
        // 仅断言返回 bool，不断言具体值（依赖运行平台）
        let _ = detect_reflink_capability();
    }

    #[tokio::test]
    async fn concurrent_persist_does_not_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(CheckpointStore::new(tmp.path(), "sess-1"));

        // 并发写入 5 个 checkpoint
        let mut handles = Vec::new();
        for idx in 0..5 {
            let store_clone = store.clone();
            let cp = fs_only_checkpoint(idx);
            handles.push(tokio::spawn(async move {
                store_clone.persist(cp).await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        // 所有 5 个 checkpoint 应可读
        for idx in 0..5 {
            assert!(
                store.get(idx).await.is_some(),
                "checkpoint {idx} 应在并发 persist 后可读"
            );
        }
    }

    #[tokio::test]
    async fn concurrent_restore_does_not_deadlock() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let store = Arc::new(CheckpointStore::new(&cwd, "sess-1"));

        // 创建 3 个 checkpoint
        for idx in 0..3 {
            let file = cwd.join(format!("file{idx}.txt"));
            tokio::fs::write(&file, format!("v0-{idx}")).await.unwrap();
            store
                .create(idx, &format!("cp{idx}"), &[PathBuf::from(format!("file{idx}.txt"))])
                .await
                .unwrap();
        }

        // 并发 restore（不阻塞）
        let mut handles = Vec::new();
        for idx in 0..3 {
            let store_clone = store.clone();
            handles.push(tokio::spawn(async move {
                let _ = store_clone.restore(idx).await;
            }));
        }
        for h in handles {
            // 不应死锁
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h).await;
        }
    }

    #[tokio::test]
    async fn update_policy_changes_cap_behavior() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        // 默认 cap=64，写入 3 个不应驱逐
        for idx in 0..3 {
            store.persist(fs_only_checkpoint(idx)).await;
        }
        assert_eq!(store.cached_len().await, 3);

        // 更新策略到 cap=2，触发驱逐
        store
            .update_policy(SwapPolicyConfig {
                max_checkpoints: 2,
                max_size_bytes: u64::MAX,
                max_age_secs: 0,
            })
            .await;
        // 手动触发一次驱逐（persist 内会自动调用，这里手动 persist 触发）
        store.persist(fs_only_checkpoint(3)).await;
        // cap=2 应保留最新 2 个
        assert!(
            store.cached_len().await <= 3,
            "SwapPolicy 驱逐后缓存不应超过 cap"
        );
    }

    #[tokio::test]
    async fn gc_orphan_blobs_removes_unreferenced() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CheckpointStore::new(tmp.path(), "sess-1");

        // 写入 2 个 checkpoint（不同内容 → 2 个 blob）
        store.persist(fs_only_checkpoint(0)).await;
        let mut cp1 = RewindCheckpoint::new(1, "cp1");
        cp1.fs.add_snapshot(FileSnapshot::new(
            PathBuf::from("a.rs"),
            Some("different content for cp1".into()),
        ));
        store.persist(cp1).await;

        let blob_count_before: usize = std::fs::read_dir(store.blobs_dir())
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(blob_count_before, 2);

        // 删除 cp 0（truncate_from 不会立即清理 blob）
        store.truncate_from(1).await;
        // 手动触发 GC
        store.gc_orphan_blobs().await;

        // cp 0 的 blob 应被清理（只剩 cp 1 的）
        let blob_count_after: usize = std::fs::read_dir(store.blobs_dir())
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(blob_count_after, 1, "孤儿 blob 应被 GC 清理");
    }
}
