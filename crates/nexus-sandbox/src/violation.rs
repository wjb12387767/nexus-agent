// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/types.rs 与 src/logging.rs）。Nexus Agent 在此基础上
// 重写，将 types.rs + logging.rs 合并为 violation.rs，并移除对 xai-grok-config
// 的依赖（改用 crate::workspace::nexus_home）。
//
//! 沙箱事件类型、计数器与日志记录器。
//!
//! 记录沙箱事件（profile 应用、违规、bypass）用于遥测与调试。事件保存在
//! 内存中，可被 flush 到 `~/.nexus/sandbox-events.jsonl` 的 JSONL 文件。

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::workspace::nexus_home;

/// 一条沙箱事件记录，用于遥测和调试。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxEvent {
    pub timestamp: DateTime<Utc>,
    pub event_type: SandboxEventType,
    pub profile: String,

    // 上下文字段——出现在 ProfileApplied/ApplyFailed 上
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enforced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restrict_network: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_write_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_paths: Option<Vec<String>>,

    // 违规/错误字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SandboxEvent {
    fn base(event_type: SandboxEventType, profile: &str) -> Self {
        Self {
            timestamp: Utc::now(),
            event_type,
            profile: profile.to_string(),
            workspace: None,
            platform: None,
            enforced: None,
            restrict_network: None,
            read_write_paths: None,
            read_only_paths: None,
            deny_paths: None,
            operation: None,
            target: None,
            command: None,
            tool_call_id: None,
            error: None,
        }
    }

    /// 创建一个带完整上下文的 "profile applied" 事件。
    pub fn profile_applied(
        profile: &str,
        workspace: &std::path::Path,
        resolved: &crate::profile::SandboxProfile,
    ) -> Self {
        let platform = if cfg!(target_os = "linux") {
            "linux/landlock"
        } else if cfg!(target_os = "macos") {
            "macos/seatbelt"
        } else if cfg!(windows) {
            "windows/iso-fs"
        } else {
            "unknown"
        };

        let mut event = Self::base(SandboxEventType::ProfileApplied, profile);
        event.workspace = Some(workspace.display().to_string());
        event.platform = Some(platform.to_string());
        event.enforced = Some(true);
        event.restrict_network = Some(resolved.restrict_network);
        event.read_write_paths = Some(
            resolved
                .read_write
                .iter()
                .map(|p| p.display().to_string())
                .collect(),
        );
        if !resolved.read_only.is_empty() {
            event.read_only_paths = Some(
                resolved
                    .read_only
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect(),
            );
        }
        if !resolved.deny.is_empty() {
            event.deny_paths = Some(
                resolved
                    .deny
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect(),
            );
        }
        event
    }

    /// 创建一个带上下文的 "apply failed" 事件。
    pub fn apply_failed(
        profile: &str,
        workspace: &std::path::Path,
        error: &dyn std::fmt::Display,
    ) -> Self {
        let platform = if cfg!(target_os = "linux") {
            "linux/landlock"
        } else if cfg!(target_os = "macos") {
            "macos/seatbelt"
        } else if cfg!(windows) {
            "windows/iso-fs"
        } else {
            "unknown"
        };

        let mut event = Self::base(SandboxEventType::ApplyFailed, profile);
        event.workspace = Some(workspace.display().to_string());
        event.platform = Some(platform.to_string());
        event.enforced = Some(false);
        event.error = Some(error.to_string());
        event
    }

    /// 创建一个文件系统违规事件。
    pub fn fs_violation(profile: &str, target: &str, operation: &str) -> Self {
        let mut event = Self::base(SandboxEventType::FsViolation, profile);
        event.operation = Some(operation.to_string());
        event.target = Some(target.to_string());
        event
    }

    /// 创建一个网络违规事件。
    pub fn net_violation(profile: &str, target: &str) -> Self {
        let mut event = Self::base(SandboxEventType::NetViolation, profile);
        event.operation = Some("connect".to_string());
        event.target = Some(target.to_string());
        event
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SandboxEventType {
    ProfileApplied,
    ApplyFailed,
    FsViolation,
    NetViolation,
    BypassGranted,
    BypassDenied,
}

/// 沙箱活动计数器，用于遥测面板。
#[derive(Debug, Default)]
pub struct SandboxMetrics {
    pub fs_violations: AtomicU64,
    pub net_violations: AtomicU64,
    pub bypasses_granted: AtomicU64,
    pub bypasses_denied: AtomicU64,
}

impl SandboxMetrics {
    pub fn inc_fs_violation(&self) {
        self.fs_violations.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_net_violation(&self) {
        self.net_violations.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_bypass_granted(&self) {
        self.bypasses_granted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_bypass_denied(&self) {
        self.bypasses_denied.fetch_add(1, Ordering::Relaxed);
    }

    pub fn fs_violation_count(&self) -> u64 {
        self.fs_violations.load(Ordering::Relaxed)
    }

    pub fn net_violation_count(&self) -> u64 {
        self.net_violations.load(Ordering::Relaxed)
    }
}

/// 收集沙箱事件并维护违规计数器的日志记录器。
pub struct SandboxLogger {
    events: Mutex<Vec<SandboxEvent>>,
    metrics: SandboxMetrics,
}

impl SandboxLogger {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            metrics: SandboxMetrics::default(),
        }
    }

    /// 记录一个事件，并按需更新计数器。
    pub fn log(&self, event: SandboxEvent) {
        match &event.event_type {
            SandboxEventType::FsViolation => self.metrics.inc_fs_violation(),
            SandboxEventType::NetViolation => self.metrics.inc_net_violation(),
            SandboxEventType::BypassGranted => self.metrics.inc_bypass_granted(),
            SandboxEventType::BypassDenied => self.metrics.inc_bypass_denied(),
            _ => {}
        }

        tracing::debug!(
            event_type = ?event.event_type,
            profile = %event.profile,
            target = ?event.target,
            operation = ?event.operation,
            "sandbox event"
        );

        if let Ok(mut events) = self.events.lock() {
            events.push(event);
        }
    }

    /// 获取计数器的引用。
    pub fn metrics(&self) -> &SandboxMetrics {
        &self.metrics
    }

    /// 取走所有累积的事件，清空内部缓冲区。
    pub fn take_events(&self) -> Vec<SandboxEvent> {
        self.events
            .lock()
            .map(|mut events| std::mem::take(&mut *events))
            .unwrap_or_default()
    }

    /// 将累积的事件 flush 到 JSONL 日志文件。每个事件写成一行 JSON。
    pub fn flush_to_disk(&self) -> anyhow::Result<()> {
        let events = self.take_events();
        if events.is_empty() {
            return Ok(());
        }

        let log_path = Self::log_file_path();
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;

        for event in &events {
            if let Ok(json) = serde_json::to_string(event) {
                writeln!(file, "{}", json)?;
            }
        }

        tracing::debug!(
            path = %log_path.display(),
            count = events.len(),
            "flushed sandbox events to disk"
        );

        Ok(())
    }

    fn log_file_path() -> PathBuf {
        nexus_home().join("sandbox-events.jsonl")
    }
}

impl Default for SandboxLogger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn fs_violation_event_carries_target_and_operation() {
        let e = SandboxEvent::fs_violation("workspace", "/etc/shadow", "write");
        assert_eq!(e.profile, "workspace");
        assert_eq!(e.target.as_deref(), Some("/etc/shadow"));
        assert_eq!(e.operation.as_deref(), Some("write"));
        assert!(matches!(e.event_type, SandboxEventType::FsViolation));
    }

    #[test]
    fn net_violation_event_sets_connect_operation() {
        let e = SandboxEvent::net_violation("strict", "1.2.3.4:443");
        assert_eq!(e.operation.as_deref(), Some("connect"));
        assert_eq!(e.target.as_deref(), Some("1.2.3.4:443"));
        assert!(matches!(e.event_type, SandboxEventType::NetViolation));
    }

    #[test]
    fn logger_increments_fs_violation_counter() {
        let l = SandboxLogger::new();
        assert_eq!(l.metrics().fs_violation_count(), 0);
        l.log(SandboxEvent::fs_violation("workspace", "/x", "write"));
        l.log(SandboxEvent::fs_violation("workspace", "/y", "write"));
        assert_eq!(l.metrics().fs_violation_count(), 2);
        assert_eq!(l.metrics().net_violation_count(), 0);
    }

    #[test]
    fn logger_increments_net_violation_counter() {
        let l = SandboxLogger::new();
        l.log(SandboxEvent::net_violation("strict", "1.2.3.4:443"));
        assert_eq!(l.metrics().net_violation_count(), 1);
    }

    #[test]
    fn logger_take_events_drains_buffer() {
        let l = SandboxLogger::new();
        l.log(SandboxEvent::fs_violation("workspace", "/x", "write"));
        l.log(SandboxEvent::net_violation("strict", "1.2.3.4:443"));
        let drained = l.take_events();
        assert_eq!(drained.len(), 2);
        // 二次 take 应为空
        assert!(l.take_events().is_empty());
    }

    #[test]
    fn apply_failed_event_records_error_message() {
        let ws = Path::new("/tmp/ws");
        let err = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        let e = SandboxEvent::apply_failed("workspace", ws, &err);
        assert_eq!(e.workspace.as_deref(), Some("/tmp/ws"));
        assert_eq!(e.enforced, Some(false));
        assert!(e.error.as_deref().unwrap().contains("boom"));
    }

    #[test]
    fn bypass_counters_track_granted_and_denied() {
        let l = SandboxLogger::new();
        l.log(SandboxEvent {
            event_type: SandboxEventType::BypassGranted,
            ..SandboxEvent::base(SandboxEventType::BypassGranted, "workspace")
        });
        l.log(SandboxEvent {
            event_type: SandboxEventType::BypassDenied,
            ..SandboxEvent::base(SandboxEventType::BypassDenied, "workspace")
        });
        l.log(SandboxEvent {
            event_type: SandboxEventType::BypassDenied,
            ..SandboxEvent::base(SandboxEventType::BypassDenied, "workspace")
        });
        assert_eq!(l.metrics().bypasses_granted.load(Ordering::Relaxed), 1);
        assert_eq!(l.metrics().bypasses_denied.load(Ordering::Relaxed), 2);
    }
}
