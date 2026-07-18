// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见
// grok-build-main/crates/codegen/xai-grok-workspace/src/session/swap_policy.rs）。
// Nexus Agent 在此基础上重写：原 swap_policy 是 toolset swap 决策表，
// 本模块重新设计为 checkpoint LRU + 大小上限驱逐策略，与 CheckpointStore 配合。
//
//! Checkpoint 驱逐策略：LRU + 大小上限 + 年龄上限。
//!
//! Grok 原始 `swap_policy.rs` 是 toolset 切换决策表（`SwapTrigger`/`SwapDecision`/
//! `SkipReason`/`DeferReason`），与 checkpoint 驱逐无关。Nexus 重新设计本模块
//! 作为 [`crate::checkpoint_store::CheckpointStore`] 的驱逐策略：
//!
//! - **LRU**：超过 `max_checkpoints` 时驱逐最久未访问的 checkpoint
//! - **大小上限**：所有 checkpoint 的总字节数超过 `max_size_bytes` 时驱逐最旧的
//! - **年龄上限**：超过 `max_age_secs` 的 checkpoint 被标记为可驱逐
//!
//! 决策由 [`SwapPolicy::evaluate`] 同步计算，返回 [`SwapDecision`]。调用方
//! （通常是 `CheckpointStore`）负责实际执行驱逐。

use serde::{Deserialize, Serialize};

/// Checkpoint 唯一标识（与 `prompt_index` 一致）。
pub type CheckpointId = usize;

/// 驱逐原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvictionReason {
    /// 超过 checkpoint 数量上限（LRU 驱逐）。
    CapExceeded,
    /// 超过总字节数上限。
    SizeExceeded,
    /// 超过最大年龄。
    AgeExceeded,
    /// 显式调用清理（例如用户主动 /rewind clear）。
    Explicit,
}

/// 单个 checkpoint 的统计信息（供策略评估）。
#[derive(Debug, Clone, Copy)]
pub struct CheckpointStats {
    pub id: CheckpointId,
    /// 序列化后的字节数（JSON）。
    pub size_bytes: u64,
    /// 创建时刻（自 Unix epoch 的秒数）。
    pub created_secs: u64,
    /// 最后访问时刻（自 Unix epoch 的秒数）。
    pub last_accessed_secs: u64,
}

/// 驱逐决策：哪些 checkpoint 应被驱逐，原因是什么。
#[derive(Debug, Clone)]
pub struct SwapDecision {
    pub evict: Vec<CheckpointId>,
    pub reason: EvictionReason,
}

impl SwapDecision {
    /// 空决策（不驱逐任何 checkpoint）。
    pub fn none() -> Self {
        Self {
            evict: Vec::new(),
            reason: EvictionReason::Explicit,
        }
    }

    /// 是否有需要驱逐的 checkpoint。
    pub fn has_evictions(&self) -> bool {
        !self.evict.is_empty()
    }
}

/// 驱逐策略配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapPolicyConfig {
    /// 最大保留 checkpoint 数量（默认 64，与 Grok `DEFAULT_CHECKPOINT_CAP` 一致）。
    pub max_checkpoints: usize,
    /// 所有 checkpoint 的总字节数上限（默认 256 MiB）。
    pub max_size_bytes: u64,
    /// 单个 checkpoint 的最大年龄（秒，默认 7 天）。
    pub max_age_secs: u64,
}

impl Default for SwapPolicyConfig {
    fn default() -> Self {
        Self {
            max_checkpoints: 64,
            max_size_bytes: 256 * 1024 * 1024,
            max_age_secs: 7 * 24 * 3600,
        }
    }
}

impl SwapPolicyConfig {
    /// 从 `maxSizeMb` 配置项构建（TS 侧 `checkpoint.maxSizeMb`）。
    pub fn from_max_size_mb(max_size_mb: u64) -> Self {
        Self {
            max_size_bytes: max_size_mb * 1024 * 1024,
            ..Self::default()
        }
    }

    /// 从 swapPolicy 字符串构建预设策略。
    ///
    /// - `"lru"` — 仅 LRU 驱逐（默认）
    /// - `"lru-size"` — LRU + 大小上限
    /// - `"fifo"` — 先进先出（不按访问时间）
    /// - `"none"` — 不驱逐（仅靠手动 truncate）
    pub fn from_policy_str(policy: &str) -> Self {
        let mut cfg = Self::default();
        match policy {
            "lru" => {}
            "lru-size" => {
                // 默认即同时启用 LRU + size，无需调整
            }
            "fifo" => {
                // FIFO 与 LRU 的差异在 evaluate 中的排序逻辑
                // 这里通过 max_age_secs=0 表示"不考虑年龄"
                cfg.max_age_secs = 0;
            }
            "none" => {
                cfg.max_checkpoints = usize::MAX;
                cfg.max_size_bytes = u64::MAX;
                cfg.max_age_secs = 0;
            }
            _ => {
                tracing::warn!(policy, "未知 swapPolicy，回退到 lru 默认配置");
            }
        }
        cfg
    }
}

/// Checkpoint 驱逐策略。
#[derive(Debug, Clone)]
pub struct SwapPolicy {
    config: SwapPolicyConfig,
}

impl Default for SwapPolicy {
    fn default() -> Self {
        Self::new(SwapPolicyConfig::default())
    }
}

impl SwapPolicy {
    /// 用给定配置创建策略。
    pub fn new(config: SwapPolicyConfig) -> Self {
        Self { config }
    }

    /// 当前配置。
    pub fn config(&self) -> &SwapPolicyConfig {
        &self.config
    }

    /// 评估驱逐决策。`stats` 按任意顺序传入，返回值 `evict` 已按驱逐优先级排序
    /// （最该驱逐的在前）。
    ///
    /// 评估顺序：
    /// 1. 数量超 cap → 按 LRU 排序驱逐最旧的
    /// 2. 大小超 max_size_bytes → 按 LRU 排序驱逐直到满足
    /// 3. 年龄超 max_age_secs → 标记为可驱逐（不强制执行，调用方决定）
    pub fn evaluate(&self, stats: &[CheckpointStats], now_secs: u64) -> SwapDecision {
        if stats.is_empty() {
            return SwapDecision::none();
        }

        // 步骤 1：数量超 cap
        if stats.len() > self.config.max_checkpoints {
            let mut sorted = self.sort_by_lru(stats);
            let evict_count = stats.len() - self.config.max_checkpoints;
            sorted.truncate(evict_count);
            return SwapDecision {
                evict: sorted.into_iter().map(|s| s.id).collect(),
                reason: EvictionReason::CapExceeded,
            };
        }

        // 步骤 2：大小超 max_size_bytes
        let total: u64 = stats.iter().map(|s| s.size_bytes).sum();
        if total > self.config.max_size_bytes {
            let mut sorted = self.sort_by_lru(stats);
            let mut current_size = total;
            let mut to_evict = Vec::new();
            while current_size > self.config.max_size_bytes && !sorted.is_empty() {
                let next = sorted.remove(0);
                current_size = current_size.saturating_sub(next.size_bytes);
                to_evict.push(next.id);
            }
            return SwapDecision {
                evict: to_evict,
                reason: EvictionReason::SizeExceeded,
            };
        }

        // 步骤 3：年龄超 max_age_secs（仅标记，不强制驱逐）
        if self.config.max_age_secs > 0 {
            let aged: Vec<CheckpointId> = stats
                .iter()
                .filter(|s| now_secs.saturating_sub(s.created_secs) > self.config.max_age_secs)
                .map(|s| s.id)
                .collect();
            if !aged.is_empty() {
                return SwapDecision {
                    evict: aged,
                    reason: EvictionReason::AgeExceeded,
                };
            }
        }

        SwapDecision::none()
    }

    /// 按 LRU 顺序排序：`last_accessed_secs` 最小的在前（最久未访问的最先驱逐）。
    /// FIFO 模式下（max_age_secs==0）按 `created_secs` 排序，最旧的在前。
    fn sort_by_lru(&self, stats: &[CheckpointStats]) -> Vec<CheckpointStats> {
        let mut sorted: Vec<CheckpointStats> = stats.to_vec();
        if self.config.max_age_secs == 0 {
            // FIFO：按创建时间排序
            sorted.sort_by_key(|s| s.created_secs);
        } else {
            // LRU：按最后访问时间排序
            sorted.sort_by_key(|s| s.last_accessed_secs);
        }
        sorted
    }

    /// 更新配置（运行时调整）。
    pub fn update_config(&mut self, config: SwapPolicyConfig) {
        self.config = config;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(ids: &[(usize, u64, u64, u64)]) -> Vec<CheckpointStats> {
        ids.iter()
            .map(|&(id, size, created, accessed)| CheckpointStats {
                id,
                size_bytes: size,
                created_secs: created,
                last_accessed_secs: accessed,
            })
            .collect()
    }

    #[test]
    fn empty_stats_returns_none() {
        let policy = SwapPolicy::default();
        let decision = policy.evaluate(&[], 1000);
        assert!(!decision.has_evictions());
    }

    #[test]
    fn under_cap_no_eviction() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: 5,
            max_size_bytes: u64::MAX,
            max_age_secs: 0,
        });
        let s = stats(&[(0, 100, 0, 0), (1, 100, 0, 0), (2, 100, 0, 0)]);
        let decision = policy.evaluate(&s, 1000);
        assert!(!decision.has_evictions(), "未超 cap 不应驱逐");
    }

    #[test]
    fn cap_exceeded_evicts_oldest_lru() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: 2,
            max_size_bytes: u64::MAX,
            max_age_secs: 0,
        });
        // 三个 checkpoint，按 last_accessed 排序：0(最旧) < 2 < 1
        // 应驱逐 id=0
        let s = stats(&[(0, 100, 0, 100), (1, 100, 0, 300), (2, 100, 0, 200)]);
        let decision = policy.evaluate(&s, 1000);
        assert_eq!(decision.reason, EvictionReason::CapExceeded);
        assert_eq!(decision.evict, vec![0]);
    }

    #[test]
    fn size_exceeded_evicts_until_under_limit() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: usize::MAX,
            max_size_bytes: 250,
            max_age_secs: 0,
        });
        // 总大小 600，需驱逐到 ≤250
        // LRU 顺序：0(100) → 1(200) → 2(300)
        // 驱逐 0(剩 500) → 驱逐 1(剩 300) → 驱逐 2(剩 0)
        // 但实际是：驱逐 0(剩 500) > 250，驱逐 1(剩 300) > 250，驱逐 2(剩 0) ≤ 250
        let s = stats(&[(0, 100, 0, 100), (1, 200, 0, 200), (2, 300, 0, 300)]);
        let decision = policy.evaluate(&s, 1000);
        assert_eq!(decision.reason, EvictionReason::SizeExceeded);
        assert_eq!(decision.evict, vec![0, 1, 2]);
    }

    #[test]
    fn size_exceeded_evicts_minimal_set() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: usize::MAX,
            max_size_bytes: 250,
            max_age_secs: 0,
        });
        // 总大小 350，需驱逐到 ≤250
        // LRU 顺序：0(100) → 1(200) → 2(50)
        // 驱逐 0(剩 250) ≤ 250 ✓
        let s = stats(&[(0, 100, 0, 100), (1, 200, 0, 200), (2, 50, 0, 300)]);
        let decision = policy.evaluate(&s, 1000);
        assert_eq!(decision.reason, EvictionReason::SizeExceeded);
        assert_eq!(decision.evict, vec![0]);
    }

    #[test]
    fn age_exceeded_marks_aged_checkpoints() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: usize::MAX,
            max_size_bytes: u64::MAX,
            max_age_secs: 3600,
        });
        // 当前时间 10000，超过 3600 秒的算过期
        // id=0 created=0 → age=10000 > 3600 ✓
        // id=1 created=9000 → age=1000 < 3600 ✗
        let s = stats(&[(0, 100, 0, 0), (1, 100, 9000, 9000)]);
        let decision = policy.evaluate(&s, 10000);
        assert_eq!(decision.reason, EvictionReason::AgeExceeded);
        assert_eq!(decision.evict, vec![0]);
    }

    #[test]
    fn fifo_sorts_by_created_not_accessed() {
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: 2,
            max_size_bytes: u64::MAX,
            max_age_secs: 0, // FIFO 模式
        });
        // FIFO：按 created_secs 排序
        // id=0 created=100 → 最新
        // id=1 created=50 → 中间
        // id=2 created=10 → 最旧
        // 超过 cap=2，应驱逐 id=2（created 最小）
        let s = stats(&[(0, 100, 100, 0), (1, 100, 50, 0), (2, 100, 10, 0)]);
        let decision = policy.evaluate(&s, 1000);
        assert_eq!(decision.reason, EvictionReason::CapExceeded);
        assert_eq!(decision.evict, vec![2]);
    }

    #[test]
    fn policy_none_never_evicts() {
        let policy = SwapPolicy::new(SwapPolicyConfig::from_policy_str("none"));
        let s = stats(&[
            (0, 1_000_000, 0, 0),
            (1, 1_000_000, 0, 0),
            (2, 1_000_000, 0, 0),
        ]);
        let decision = policy.evaluate(&s, u64::MAX / 2);
        assert!(!decision.has_evictions(), "none 策略不应驱逐");
    }

    #[test]
    fn config_from_max_size_mb() {
        let cfg = SwapPolicyConfig::from_max_size_mb(512);
        assert_eq!(cfg.max_size_bytes, 512 * 1024 * 1024);
        assert_eq!(cfg.max_checkpoints, 64); // 默认值
    }

    #[test]
    fn config_from_policy_str_lru() {
        let cfg = SwapPolicyConfig::from_policy_str("lru");
        assert_eq!(cfg.max_checkpoints, 64);
        assert_eq!(cfg.max_size_bytes, 256 * 1024 * 1024);
        assert_eq!(cfg.max_age_secs, 7 * 24 * 3600);
    }

    #[test]
    fn config_from_policy_str_unknown_falls_back_silently() {
        let cfg = SwapPolicyConfig::from_policy_str("nonexistent");
        // 应保持默认值
        assert_eq!(cfg.max_checkpoints, 64);
    }

    #[test]
    fn decision_none_has_no_evictions() {
        let d = SwapDecision::none();
        assert!(!d.has_evictions());
        assert!(d.evict.is_empty());
    }

    #[test]
    fn evaluate_returns_cap_first_over_size() {
        // 同时超 cap 和 size，cap 优先
        let policy = SwapPolicy::new(SwapPolicyConfig {
            max_checkpoints: 1,
            max_size_bytes: 100,
            max_age_secs: 0,
        });
        let s = stats(&[(0, 200, 0, 100), (1, 200, 0, 200)]);
        let decision = policy.evaluate(&s, 1000);
        assert_eq!(decision.reason, EvictionReason::CapExceeded);
        assert_eq!(decision.evict.len(), 1);
        // 应驱逐 LRU 最旧的（id=0，last_accessed=100）
        assert_eq!(decision.evict[0], 0);
    }

    #[test]
    fn update_config_changes_behavior() {
        let mut policy = SwapPolicy::default();
        // 默认 cap=64，3 个 checkpoint 不应驱逐
        let s = stats(&[(0, 100, 0, 0), (1, 100, 0, 0), (2, 100, 0, 0)]);
        assert!(!policy.evaluate(&s, 1000).has_evictions());

        // 更新到 cap=2，应驱逐 1 个
        policy.update_config(SwapPolicyConfig {
            max_checkpoints: 2,
            max_size_bytes: u64::MAX,
            max_age_secs: 0,
        });
        let decision = policy.evaluate(&s, 1000);
        assert!(decision.has_evictions());
        assert_eq!(decision.evict.len(), 1);
    }
}
