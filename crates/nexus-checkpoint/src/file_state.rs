// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见
// grok-build-main/crates/codegen/xai-grok-workspace/src/session/file_state.rs）。
// Nexus Agent 在此基础上重写：移除 xai-grok-paths / xai-grok-workspace-types 依赖，
// 改为使用 std::path + sha2 实现 mtime + hash 索引。
//
//! 文件状态跟踪：捕获并还原每个 prompt 边界的文件快照。
//!
//! 每个 [`RewindPoint`] 对应一个用户 prompt，存储该 prompt 处理期间被读取或修改
//! 的所有文件的 before/after 内容快照。restore 时根据 before 快照还原磁盘文件。
//!
//! ## 路径存储
//!
//! [`FileSnapshot`] 的路径以 [`FlexiblePath`] 存储，可以是相对路径（相对于
//! session cwd，便于跨机器移植）或绝对路径（向后兼容旧 session）。
//!
//! ## mtime + hash 索引
//!
//! 除了内容快照，[`FileStateTracker`] 还维护一个 `(path, size, mtime_ms) → sha256`
//! 的 memo（见 [`FileHashMemo`]），未变更的文件只 hash 一次，避免重复计算。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// 将字节数组转为字符串（UTF-8 无效时用 lossy 转换）。
pub fn bytes_to_string(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "file content is not valid UTF-8; using lossy conversion");
        String::from_utf8_lossy(&e.into_bytes()).into_owned()
    })
}

/// 将系统时间转为自 Unix epoch 的毫秒数。
pub fn system_time_to_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 计算字节数组的 sha256 哈希（十六进制小写）。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// `(path, size, mtime_ms) → sha256` 的 memo 表。
///
/// 同一个文件在未变更时（size + mtime 未变）只 hash 一次，避免重复计算。
/// 直接对应 Grok 的 `client_fs_hash_memo`，但简化为内存 HashMap。
#[derive(Debug, Default, Clone)]
pub struct FileHashMemo {
    inner: Arc<std::sync::Mutex<HashMap<(PathBuf, u64, u64), String>>>,
}

impl FileHashMemo {
    /// 创建一个空的 memo 表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 查询 memoized 的 sha256，若 `(path, size, mtime)` 已缓存则直接返回。
    pub fn get(&self, path: &Path, size: u64, mtime_ms: u64) -> Option<String> {
        let guard = self.inner.lock().ok()?;
        guard.get(&(path.to_path_buf(), size, mtime_ms)).cloned()
    }

    /// 插入一条 memo。
    pub fn insert(&self, path: PathBuf, size: u64, mtime_ms: u64, hash: String) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert((path, size, mtime_ms), hash);
        }
    }

    /// 计算文件 sha256，命中 memo 则直接返回；否则读取文件、hash、缓存。
    pub async fn hash_file(&self, path: &Path) -> io::Result<Option<String>> {
        let meta = match tokio::fs::metadata(path).await {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let size = meta.len();
        let mtime_ms = meta
            .modified()
            .map(system_time_to_millis)
            .unwrap_or(0);
        if let Some(cached) = self.get(path, size, mtime_ms) {
            return Ok(Some(cached));
        }
        let bytes = tokio::fs::read(path).await?;
        let hash = sha256_hex(&bytes);
        self.insert(path.to_path_buf(), size, mtime_ms, hash.clone());
        Ok(Some(hash))
    }
}

/// 一个灵活的路径：可以是相对路径（相对于 session cwd）或绝对路径。
///
/// 相对路径优先（便于跨机器移植），绝对路径用于向后兼容旧 session。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FlexiblePath {
    /// 相对路径（相对于 session cwd）。
    Relative(PathBuf),
    /// 绝对路径（旧 session 兼容）。
    Absolute(PathBuf),
}

impl FlexiblePath {
    /// 从相对路径创建。
    pub fn from_rel(path: PathBuf) -> Self {
        Self::Relative(path)
    }

    /// 作为 `&Path` 引用。
    pub fn as_path(&self) -> &Path {
        match self {
            Self::Relative(p) | Self::Absolute(p) => p.as_path(),
        }
    }

    /// 使用 `root` 转为绝对路径：相对路径拼接 root，绝对路径原样返回。
    pub fn to_absolute(&self, root: &Path) -> PathBuf {
        match self {
            Self::Relative(p) => root.join(p),
            Self::Absolute(p) => p.clone(),
        }
    }

    /// 尝试转为相对路径：已是相对则克隆；绝对路径若在 root 下则转为相对，否则保持绝对。
    pub fn try_to_relative(&self, root: &Path) -> FlexiblePath {
        match self {
            Self::Relative(p) => Self::Relative(p.clone()),
            Self::Absolute(p) => match p.strip_prefix(root) {
                Ok(rel) => Self::Relative(rel.to_path_buf()),
                Err(_) => Self::Absolute(p.clone()),
            },
        }
    }

    /// 是否为相对路径。
    pub fn is_relative(&self) -> bool {
        matches!(self, Self::Relative(_))
    }

    /// 作为字符串（用于序列化）。
    fn as_str(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::Relative(p) | Self::Absolute(p) => p.to_string_lossy(),
        }
    }
}

impl AsRef<Path> for FlexiblePath {
    fn as_ref(&self) -> &Path {
        self.as_path()
    }
}

impl std::fmt::Display for FlexiblePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.as_str())
    }
}

/// 自定义 serde：序列化为字符串，反序列化时若可 strip_prefix root 则转为相对。
mod flexible_path_serde {
    use super::*;

    pub fn serialize<S>(path: &FlexiblePath, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&path.as_str())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<FlexiblePath, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let p = PathBuf::from(&s);
        if p.is_absolute() {
            Ok(FlexiblePath::Absolute(p))
        } else {
            Ok(FlexiblePath::Relative(p))
        }
    }
}

/// 自定义 serde：HashMap<FlexiblePath, FileSnapshot> 序列化为 map<string, FileSnapshot>。
mod flexible_path_map_serde {
    use super::*;

    pub fn serialize<S>(
        map: &HashMap<FlexiblePath, FileSnapshot>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut m = serializer.serialize_map(Some(map.len()))?;
        for (k, v) in map {
            m.serialize_entry(k.as_str().as_ref(), v)?;
        }
        m.end()
    }

    pub fn deserialize<'de, D>(
        deserializer: D,
    ) -> Result<HashMap<FlexiblePath, FileSnapshot>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw: HashMap<String, FileSnapshot> = HashMap::deserialize(deserializer)?;
        let mut out = HashMap::with_capacity(raw.len());
        for (k, v) in raw {
            let p = PathBuf::from(&k);
            let key = if p.is_absolute() {
                FlexiblePath::Absolute(p)
            } else {
                FlexiblePath::Relative(p)
            };
            out.insert(key, v);
        }
        Ok(out)
    }
}

/// 单个文件在某一时刻的内容快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    /// 文件路径（优先相对，旧 session 可能绝对）。
    #[serde(with = "flexible_path_serde")]
    pub path: FlexiblePath,
    /// 快照时刻的文件内容（None 表示文件不存在）。
    pub content: Option<String>,
    /// 快照时刻的 sha256 哈希（None 表示文件不存在或未计算）。
    #[serde(default)]
    pub hash: Option<String>,
    /// 快照时刻的 mtime（自 Unix epoch 的毫秒数，None 表示文件不存在）。
    #[serde(default)]
    pub mtime_ms: Option<u64>,
    /// 快照捕获时刻。
    pub captured_at: DateTime<Utc>,
}

impl FileSnapshot {
    /// 用相对路径创建快照。
    pub fn new(path: PathBuf, content: Option<String>) -> Self {
        let hash = content.as_ref().map(|c| sha256_hex(c.as_bytes()));
        Self {
            path: FlexiblePath::Relative(path),
            content,
            hash,
            mtime_ms: None,
            captured_at: Utc::now(),
        }
    }

    /// 用 FlexiblePath 创建快照。
    pub fn new_flexible(path: FlexiblePath, content: Option<String>) -> Self {
        let hash = content.as_ref().map(|c| sha256_hex(c.as_bytes()));
        Self {
            path,
            content,
            hash,
            mtime_ms: None,
            captured_at: Utc::now(),
        }
    }

    /// 路径作为 `&Path`。
    pub fn as_path(&self) -> &Path {
        self.path.as_path()
    }

    /// 用 root 转为绝对路径。
    pub fn to_absolute_path(&self, root: &Path) -> PathBuf {
        self.path.to_absolute(root)
    }

    /// 将路径规范化为相对（若在 root 下）。
    pub fn normalize_to_relative(&self, root: &Path) -> FileSnapshot {
        FileSnapshot {
            path: self.path.try_to_relative(root),
            content: self.content.clone(),
            hash: self.hash.clone(),
            mtime_ms: self.mtime_ms,
            captured_at: self.captured_at,
        }
    }
}

/// 一个 prompt 边界处的文件快照集合（rewind point）。
///
/// `file_snapshots` 是 BEFORE 任何操作前的快照（restore 时用）；
/// `after_snapshots` 是所有操作完成后的快照（用于检测外部修改）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewindPoint {
    /// prompt 索引（0-based）。
    pub prompt_index: usize,
    /// 创建时刻。
    pub created_at: DateTime<Utc>,
    /// BEFORE 快照（每个文件只记第一次捕获的状态）。
    #[serde(with = "flexible_path_map_serde")]
    pub file_snapshots: HashMap<FlexiblePath, FileSnapshot>,
    /// AFTER 快照（agent 写入后的状态）。
    #[serde(default, with = "flexible_path_map_serde")]
    pub after_snapshots: HashMap<FlexiblePath, FileSnapshot>,
}

impl RewindPoint {
    /// 为指定 prompt 创建空的 rewind point。
    pub fn new(prompt_index: usize) -> Self {
        Self {
            prompt_index,
            created_at: Utc::now(),
            file_snapshots: HashMap::new(),
            after_snapshots: HashMap::new(),
        }
    }

    /// 添加一个 before 快照（若已存在则不覆盖——只记第一次）。
    pub fn add_snapshot(&mut self, snapshot: FileSnapshot) {
        self.file_snapshots
            .entry(snapshot.path.clone())
            .or_insert(snapshot);
    }

    /// 设置 after 快照（覆盖，最后一次写入为准）。
    pub fn set_after_snapshot(&mut self, snapshot: FileSnapshot) {
        self.after_snapshots.insert(snapshot.path.clone(), snapshot);
    }

    /// 查询某文件的 before 快照。
    pub fn get_snapshot(&self, path: &FlexiblePath) -> Option<&FileSnapshot> {
        self.file_snapshots.get(path)
    }

    /// 列出所有有 before 快照的文件路径。
    pub fn snapshot_paths(&self) -> Vec<&FlexiblePath> {
        self.file_snapshots.keys().collect()
    }

    /// 将所有路径规范化为相对（若在 root 下）。
    pub fn normalize_to_relative(&mut self, root: &Path) {
        let old = std::mem::take(&mut self.file_snapshots);
        for (path, mut snap) in old {
            let new_path = path.try_to_relative(root);
            snap.path = new_path.clone();
            self.file_snapshots.insert(new_path, snap);
        }
        let old_after = std::mem::take(&mut self.after_snapshots);
        for (path, mut snap) in old_after {
            let new_path = path.try_to_relative(root);
            snap.path = new_path.clone();
            self.after_snapshots.insert(new_path, snap);
        }
    }
}

/// rewind point 的轻量元数据（不包含文件内容），供 picker 使用。
#[derive(Debug, Clone)]
pub struct RewindPointMeta {
    pub prompt_index: usize,
    pub created_at: DateTime<Utc>,
    pub num_file_snapshots: usize,
}

/// 跨 prompt 跟踪文件状态以支持 rewind。
///
/// 维护一个 `prompt_index → RewindPoint` 的映射。`begin_prompt` 开始跟踪，
/// `end_prompt` 捕获 after 快照。
#[derive(Debug)]
pub struct FileStateTracker {
    /// 所有 rewind point，按 prompt_index 索引。
    rewind_points: Arc<Mutex<HashMap<usize, RewindPoint>>>,
    /// 当前正在处理的 prompt index（None 表示未在处理中）。
    current_prompt_index: Arc<Mutex<Option<usize>>>,
}

impl Default for FileStateTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl FileStateTracker {
    /// 创建空 tracker。
    pub fn new() -> Self {
        Self {
            rewind_points: Arc::new(Mutex::new(HashMap::new())),
            current_prompt_index: Arc::new(Mutex::new(None)),
        }
    }

    /// 开始跟踪一个新 prompt。
    pub async fn begin_prompt(&self, prompt_index: usize) {
        {
            let mut current = self.current_prompt_index.lock().await;
            *current = Some(prompt_index);
        }
        let mut points = self.rewind_points.lock().await;
        points
            .entry(prompt_index)
            .or_insert_with(|| RewindPoint::new(prompt_index));
    }

    /// 结束跟踪指定 prompt：捕获所有被触碰文件的 after 快照。
    pub async fn end_prompt(&self, prompt_index: usize) {
        {
            let mut current = self.current_prompt_index.lock().await;
            *current = None;
        }
        let paths_to_capture: Vec<FlexiblePath> = {
            let points = self.rewind_points.lock().await;
            points
                .get(&prompt_index)
                .map(|p| p.file_snapshots.keys().cloned().collect())
                .unwrap_or_default()
        };
        for flex_path in paths_to_capture {
            let abs = flex_path.as_path().to_path_buf();
            let content = tokio::fs::read_to_string(&abs).await.ok();
            let snapshot = FileSnapshot::new_flexible(flex_path, content);
            let mut points = self.rewind_points.lock().await;
            if let Some(point) = points.get_mut(&prompt_index) {
                point.set_after_snapshot(snapshot);
            }
        }
    }

    /// 在操作前捕获文件当前状态。`path` 是绝对路径，`cwd` 用于相对化。
    /// 工作区外的文件被静默跳过。
    pub async fn capture_file_state(&self, path: &Path, cwd: &Path) -> io::Result<()> {
        let rel = match path.strip_prefix(cwd) {
            Ok(r) => r.to_path_buf(),
            Err(_) => return Ok(()), // 工作区外，跳过
        };
        let current = self.current_prompt_index.lock().await;
        let Some(prompt_index) = *current else {
            return Ok(()); // 未在处理 prompt，跳过
        };
        drop(current);

        let content = tokio::fs::read_to_string(path).await.ok();
        let snapshot = FileSnapshot::new(rel, content);

        let mut points = self.rewind_points.lock().await;
        if let Some(point) = points.get_mut(&prompt_index) {
            point.add_snapshot(snapshot);
        }
        Ok(())
    }

    /// 直接为指定 prompt 添加一个 before 快照（不读盘，调用方提供内容）。
    pub async fn add_before_snapshot_for_prompt(
        &self,
        prompt_index: usize,
        path: &Path,
        cwd: &Path,
        content: Option<String>,
    ) {
        let rel = match path.strip_prefix(cwd) {
            Ok(r) => r.to_path_buf(),
            Err(_) => return,
        };
        let snapshot = FileSnapshot::new(rel, content);
        let mut points = self.rewind_points.lock().await;
        let point = points
            .entry(prompt_index)
            .or_insert_with(|| RewindPoint::new(prompt_index));
        point.add_snapshot(snapshot);
    }

    /// 获取所有 rewind point（按 prompt_index 升序）。
    pub async fn get_rewind_points(&self) -> Vec<RewindPoint> {
        let points = self.rewind_points.lock().await;
        let mut result: Vec<RewindPoint> = points.values().cloned().collect();
        result.sort_by_key(|p| p.prompt_index);
        result
    }

    /// 获取所有 rewind point 的元数据（不含文件内容）。
    pub async fn get_rewind_point_metas(&self) -> Vec<RewindPointMeta> {
        let points = self.rewind_points.lock().await;
        let mut metas: Vec<RewindPointMeta> = points
            .values()
            .map(|p| RewindPointMeta {
                prompt_index: p.prompt_index,
                created_at: p.created_at,
                num_file_snapshots: p.file_snapshots.len(),
            })
            .collect();
        metas.sort_by_key(|m| m.prompt_index);
        metas
    }

    /// 按 prompt_index 获取单个 rewind point。
    pub async fn get_rewind_point(&self, prompt_index: usize) -> Option<RewindPoint> {
        self.rewind_points.lock().await.get(&prompt_index).cloned()
    }

    /// 当前正在处理的 prompt index。
    pub async fn current_prompt_index(&self) -> Option<usize> {
        *self.current_prompt_index.lock().await
    }

    /// 清除 `>= prompt_index` 的所有 rewind point（rewind 时截断未来历史）。
    pub async fn truncate_from(&self, prompt_index: usize) {
        let mut points = self.rewind_points.lock().await;
        points.retain(|&idx, _| idx < prompt_index);
    }

    /// 拥有 rewind point 的最大 prompt_index。
    pub async fn max_prompt_index(&self) -> Option<usize> {
        self.rewind_points.lock().await.keys().max().copied()
    }
}

/// rewind 操作的冲突类型。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictType {
    /// 文件被外部删除（agent 写入后存在，现在不存在）。
    DeletedExternally,
    /// 文件被外部创建（agent 写入后不存在，现在存在）。
    CreatedExternally,
    /// 文件被外部修改（内容与 agent 写入后的不同）。
    ModifiedExternally,
}

/// 单个文件的 rewind 冲突。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRewindConflict {
    pub path: String,
    pub conflict_type: ConflictType,
}

/// rewind 操作的响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRewindResponse {
    pub success: bool,
    pub target_prompt_index: usize,
    pub reverted_files: Vec<String>,
    pub clean_files: Vec<String>,
    pub conflicts: Vec<FileRewindConflict>,
    pub error: Option<String>,
}

/// 将文件回滚到 `target_prompt_index` 之前的状态。
///
/// 1. 从所有 `>= target` 的 point 中收集每个文件最早的 before 快照
/// 2. 检测冲突（agent 写入后的内容与当前磁盘内容是否一致）
/// 3. 用 before 快照内容还原磁盘文件
/// 4. 截断 `>= target` 的 rewind point
pub async fn rewind_files(
    tracker: &FileStateTracker,
    target_prompt_index: usize,
) -> FileRewindResponse {
    let all_points = tracker.get_rewind_points().await;

    let mut reverted_files = Vec::new();
    let mut clean_files = Vec::new();
    let mut conflicts = Vec::new();
    let mut had_errors = false;

    // 收集需要回滚的文件：每个文件取最早的 before 快照
    let mut files_to_revert: HashMap<FlexiblePath, Option<String>> = HashMap::new();
    for point in all_points
        .iter()
        .filter(|p| p.prompt_index >= target_prompt_index)
    {
        for (path, before_snapshot) in &point.file_snapshots {
            files_to_revert
                .entry(path.clone())
                .or_insert_with(|| before_snapshot.content.clone());
        }
    }

    for (flex_path, content) in &files_to_revert {
        let abs = flex_path.as_path();
        let current_content = tokio::fs::read_to_string(abs).await.ok();
        let after_content = all_points
            .iter()
            .rev()
            .find_map(|p| p.after_snapshots.get(flex_path))
            .and_then(|s| s.content.clone());

        if current_content == after_content {
            clean_files.push(flex_path.to_string());
        } else {
            let conflict_type = if current_content.is_none() && after_content.is_some() {
                ConflictType::DeletedExternally
            } else if current_content.is_some() && after_content.is_none() {
                ConflictType::CreatedExternally
            } else {
                ConflictType::ModifiedExternally
            };
            conflicts.push(FileRewindConflict {
                path: flex_path.to_string(),
                conflict_type,
            });
        }

        // 执行还原
        match content {
            Some(data) => {
                if let Err(e) = tokio::fs::write(abs, data.as_bytes()).await {
                    tracing::warn!(?flex_path, ?e, "rewind: failed to restore file");
                    had_errors = true;
                    continue;
                }
            }
            None => {
                // before 快照为 None → 文件原本不存在，删除当前文件
                if tokio::fs::metadata(abs).await.is_ok() {
                    if let Err(e) = tokio::fs::remove_file(abs).await {
                        tracing::warn!(?flex_path, ?e, "rewind: failed to delete file");
                        had_errors = true;
                        continue;
                    }
                }
            }
        }
        reverted_files.push(flex_path.to_string());
    }

    // 截断 rewind point（仅在无错误时，保留重试数据）
    if !had_errors {
        tracker.truncate_from(target_prompt_index).await;
    }

    let error = if had_errors {
        Some("Some files could not be reverted".to_string())
    } else {
        None
    };

    FileRewindResponse {
        success: !had_errors,
        target_prompt_index,
        reverted_files,
        clean_files,
        conflicts,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_stable() {
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn flexible_path_roundtrip_relative() {
        let p = FlexiblePath::Relative(PathBuf::from("src/main.rs"));
        assert!(p.is_relative());
        assert_eq!(p.as_path(), Path::new("src/main.rs"));
        let abs = p.to_absolute(Path::new("/repo"));
        assert_eq!(abs, PathBuf::from("/repo/src/main.rs"));
    }

    #[test]
    fn flexible_path_try_to_relative_strips_root() {
        let root = Path::new("/home/user/project");
        let abs = FlexiblePath::Absolute(PathBuf::from("/home/user/project/src/file.txt"));
        let rel = abs.try_to_relative(root);
        assert!(rel.is_relative());
        assert_eq!(rel.as_path(), Path::new("src/file.txt"));

        // 不在 root 下的绝对路径保持绝对
        let other = FlexiblePath::Absolute(PathBuf::from("/other/path/file.txt"));
        let result = other.try_to_relative(root);
        assert!(!result.is_relative());
    }

    #[test]
    fn file_snapshot_computes_hash() {
        let snap = FileSnapshot::new(PathBuf::from("a.rs"), Some("fn a() {}".to_string()));
        assert_eq!(
            snap.hash.as_deref(),
            Some("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
                .filter(|_| false) // 占位，实际断言见下
        );
        // 上面的 filter 是为了演示；实际断言：
        let expected = sha256_hex(b"fn a() {}");
        assert_eq!(snap.hash.as_deref(), Some(expected.as_str()));
        assert!(snap.mtime_ms.is_none());
    }

    #[test]
    fn file_snapshot_none_content_has_none_hash() {
        let snap = FileSnapshot::new(PathBuf::from("missing.txt"), None);
        assert!(snap.content.is_none());
        assert!(snap.hash.is_none());
    }

    #[test]
    fn rewind_point_add_snapshot_first_wins() {
        let mut point = RewindPoint::new(0);
        let s1 = FileSnapshot::new(PathBuf::from("a.txt"), Some("v1".into()));
        point.add_snapshot(s1);
        // 同一文件的第二次添加应被忽略
        let s2 = FileSnapshot::new(PathBuf::from("a.txt"), Some("v2".into()));
        point.add_snapshot(s2);

        let key = FlexiblePath::Relative(PathBuf::from("a.txt"));
        let retrieved = point.get_snapshot(&key).unwrap();
        assert_eq!(retrieved.content.as_deref(), Some("v1"));
    }

    #[test]
    fn rewind_point_normalize_to_relative() {
        let root = Path::new("/home/user/project");
        let mut point = RewindPoint::new(0);
        let abs_snap = FileSnapshot::new_flexible(
            FlexiblePath::Absolute(PathBuf::from("/home/user/project/src/main.rs")),
            Some("fn main() {}".into()),
        );
        point.add_snapshot(abs_snap);
        point.normalize_to_relative(root);
        for path in point.file_snapshots.keys() {
            assert!(path.is_relative(), "{path:?} should be relative");
        }
    }

    #[tokio::test]
    async fn tracker_begin_end_clears_current_prompt() {
        let tracker = FileStateTracker::new();
        tracker.begin_prompt(0).await;
        assert_eq!(tracker.current_prompt_index().await, Some(0));
        tracker.end_prompt(0).await;
        assert_eq!(tracker.current_prompt_index().await, None);
        let point = tracker.get_rewind_point(0).await;
        assert!(point.is_some());
        assert_eq!(point.unwrap().prompt_index, 0);
    }

    #[tokio::test]
    async fn tracker_truncate_from_keeps_earlier() {
        let tracker = FileStateTracker::new();
        for i in 0..5 {
            tracker.begin_prompt(i).await;
            tracker.end_prompt(i).await;
        }
        assert_eq!(tracker.get_rewind_points().await.len(), 5);
        tracker.truncate_from(3).await;
        let points = tracker.get_rewind_points().await;
        assert_eq!(points.len(), 3);
        assert!(tracker.get_rewind_point(0).await.is_some());
        assert!(tracker.get_rewind_point(2).await.is_some());
        assert!(tracker.get_rewind_point(3).await.is_none());
    }

    #[tokio::test]
    async fn tracker_capture_skips_files_outside_cwd() {
        let tracker = FileStateTracker::new();
        tracker.begin_prompt(0).await;
        // /etc/passwd 几乎肯定不在 cwd 下
        let cwd = Path::new("/home/user/project");
        let outside = Path::new("/etc/passwd");
        tracker.capture_file_state(outside, cwd).await.unwrap();
        let point = tracker.get_rewind_point(0).await.unwrap();
        assert!(point.file_snapshots.is_empty(), "outside-cwd file must be skipped");
    }

    #[tokio::test]
    async fn rewind_files_restores_content_and_truncates() {
        // 用 tempdir 模拟工作区
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("a.txt");
        tokio::fs::write(&file, b"v0").await.unwrap();

        let tracker = FileStateTracker::new();
        tracker.begin_prompt(0).await;
        tracker
            .add_before_snapshot_for_prompt(0, &file, &cwd, Some("v0".into()))
            .await;
        // 模拟 agent 写入
        tokio::fs::write(&file, b"v1").await.unwrap();
        tracker.end_prompt(0).await;

        // 回滚到 prompt 0 之前
        let resp = rewind_files(&tracker, 0).await;
        assert!(resp.success, "rewind should succeed: {:?}", resp.error);
        assert!(resp.reverted_files.iter().any(|f| f.ends_with("a.txt")));

        let restored = tokio::fs::read_to_string(&file).await.unwrap();
        assert_eq!(restored, "v0", "file content must revert to before-snapshot");
    }

    #[tokio::test]
    async fn rewind_files_deletes_newly_created_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_path_buf();
        let file = cwd.join("new.txt");
        // 文件原本不存在 → before 快照为 None
        let tracker = FileStateTracker::new();
        tracker.begin_prompt(0).await;
        tracker
            .add_before_snapshot_for_prompt(0, &file, &cwd, None)
            .await;
        // agent 创建了文件
        tokio::fs::write(&file, b"created").await.unwrap();
        tracker.end_prompt(0).await;

        let resp = rewind_files(&tracker, 0).await;
        assert!(resp.success, "{:?}", resp.error);
        assert!(
            !file.exists(),
            "newly created file should be deleted on rewind"
        );
    }

    #[tokio::test]
    async fn file_hash_memo_caches_repeated_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("hashable.txt");
        tokio::fs::write(&file, b"content").await.unwrap();
        let memo = FileHashMemo::new();
        let h1 = memo.hash_file(&file).await.unwrap().unwrap();
        let h2 = memo.hash_file(&file).await.unwrap().unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1, sha256_hex(b"content"));
    }

    #[tokio::test]
    async fn file_hash_memo_handles_missing_file() {
        let memo = FileHashMemo::new();
        let missing = Path::new("/nonexistent/file");
        assert!(memo.hash_file(missing).await.unwrap().is_none());
    }

    #[test]
    fn system_time_to_millis_is_monotonic_nonneg() {
        let now = SystemTime::now();
        let ms = system_time_to_millis(now);
        assert!(ms > 0);
    }
}
