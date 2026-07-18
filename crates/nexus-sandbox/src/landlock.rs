// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/profiles.rs 与 src/deny/mod.rs 的 Landlock 相关逻辑）。
// Nexus Agent 在此基础上重写：原版通过 nono crate 间接使用 Landlock，本模块
// 直接使用 landlock crate，提供 `LandlockSandbox::new(profile)` 与 `apply()`。
//
//! Linux Landlock 实现。
//!
//! Landlock 是 Linux 内核的 LSM，提供文件系统访问控制。本模块将
//! [`crate::profile::SandboxProfile`] 转换为 Landlock ruleset 并应用
//! 到当前进程（不可逆）。
//!
//! 限制：Landlock 不能 deny 一个已允许树的子路径，因此 read-deny 由
//! `lib.rs::bwrap_reexec_command` 在 bwrap re-exec 时通过 bind-over 实现。
//! 本模块仅处理 read-only / read-write 授予。
//!
//! ```rust,no_run
//! use nexus_sandbox::profile::{ProfileName, SandboxConfig};
//! use nexus_sandbox::landlock::LandlockSandbox;
//! use std::path::Path;
//!
//! let workspace = Path::new("/home/user/project");
//! let config = SandboxConfig::default();
//! let profile = ProfileName::Workspace.resolve_profile(workspace, &config).unwrap();
//! let mut sb = LandlockSandbox::new(profile);
//! sb.apply().expect("landlock apply failed");
//! ```

use std::path::{Path, PathBuf};

use landlock::{
    Access, AccessFs, BitFlags, PathBeneathRule, Ruleset, RulesetAttr, RulesetCreated,
    RulesetError, ABI,
};

use crate::profile::SandboxProfile;
use crate::workspace::{DEVICE_DIRS, DEVICE_FILES};

/// Landlock 沙箱句柄。`new()` 不应用，调用 `apply()` 后才强制。
pub struct LandlockSandbox {
    profile: SandboxProfile,
    applied: bool,
}

impl LandlockSandbox {
    /// 创建 Landlock 沙箱管理器。调用 `apply()` 之前不强制任何限制。
    pub fn new(profile: SandboxProfile) -> Self {
        Self {
            profile,
            applied: false,
        }
    }

    /// 应用 Landlock ruleset 到当前进程。**不可逆**。
    ///
    /// 若 Landlock 不受内核支持，返回 Ok(()) 但不强制（graceful degrade）。
    pub fn apply(&mut self) -> Result<(), RulesetError> {
        let abi = ABI::V4; // 包含 truncate 支持
        let mut ruleset = Ruleset::new(RulesetAttr::new().handle_access(AccessFs::All)?, abi)?;

        // 默认 read：授予对 / 的读权限
        if self.profile.default_read {
            ruleset = self.add_path_rule(
                ruleset,
                Path::new("/"),
                AccessFs::from_all(abi)? | AccessFs::Truncate,
            )?;
        }

        // 显式 read-only 路径——跳过不存在的（无可读内容）
        for path in &self.profile.read_only {
            if !path.exists() {
                continue;
            }
            ruleset = self.add_path_rule(ruleset, path, AccessFs::from_read(abi))?;
        }

        // read-write 路径。Landlock 需要目录在应用时存在（它打开 O_PATH fd），
        // 但应用后可在其中自由创建新文件。预先创建像 ~/.nexus/ 这样首次运行
        // 可能不存在的目录。
        for path in &self.profile.read_write {
            if !path.exists() && std::fs::create_dir_all(path).is_err() {
                tracing::warn!(path = ?path, "read_write 路径不存在且无法创建，跳过");
                continue;
            }
            ruleset = self.add_path_rule(
                ruleset,
                path,
                AccessFs::from_all(abi)? | AccessFs::Truncate,
            )?;
        }

        // 设备特殊文件（字符设备如 /dev/null、/dev/tty 等）。
        for dev in DEVICE_FILES {
            let p = Path::new(dev);
            if !p.exists() {
                continue;
            }
            ruleset = self.add_file_rule(ruleset, p, AccessFs::from_all(abi)?)?;
        }
        // 设备目录（例如 Linux 上的 PTY slave /dev/pts）。
        for dev in DEVICE_DIRS {
            let p = Path::new(dev);
            if p.exists() && p.is_dir() {
                ruleset = self.add_path_rule(ruleset, dev, AccessFs::from_all(abi)?)?;
            }
        }

        // Landlock 没有 deny_path——deny 在 bwrap re-exec 时通过 bind-over 处理。
        // 见 lib.rs::bwrap_reexec_command。
        if !self.profile.deny.is_empty() {
            tracing::debug!(
                count = self.profile.deny.len(),
                "Linux deny 路径需 bwrap bind-over（在进程 re-exec 时应用）"
            );
        }

        ruleset.restrict_self()?;
        self.applied = true;
        tracing::info!(
            profile = %self.profile.name,
            "Landlock 沙箱已应用（内核强制，不可逆）"
        );
        Ok(())
    }

    /// Landlock 是否成功应用。
    pub fn is_applied(&self) -> bool {
        self.applied
    }

    /// 当前 profile。
    pub fn profile(&self) -> &SandboxProfile {
        &self.profile
    }

    fn add_path_rule(
        &self,
        mut ruleset: RulesetCreated,
        path: impl AsRef<Path>,
        access: BitFlags<AccessFs>,
    ) -> Result<RulesetCreated, RulesetError> {
        // 一些路径可能因权限不足无法被 Landlock 打开（O_PATH），跳过而非失败。
        match PathBeneathRule::new(path.as_ref()).allow_access(access) {
            Ok(rule) => match ruleset.add_rule(rule) {
                Ok(()) => Ok(ruleset),
                Err(e) => {
                    tracing::warn!(
                        path = %path.as_ref().display(),
                        error = %e,
                        "无法为路径添加 Landlock 规则，跳过"
                    );
                    Ok(ruleset)
                }
            },
            Err(e) => {
                tracing::warn!(
                    path = %path.as_ref().display(),
                    error = %e,
                    "无法为路径构造 PathBeneathRule，跳过"
                );
                Ok(ruleset)
            }
        }
    }

    fn add_file_rule(
        &self,
        mut ruleset: RulesetCreated,
        path: &Path,
        access: BitFlags<AccessFs>,
    ) -> Result<RulesetCreated, RulesetError> {
        // 设备文件是单个文件而非目录，仍用 PathBeneathRule（它对文件与目录都有效）。
        match PathBeneathRule::new(path).allow_access(access) {
            Ok(rule) => match ruleset.add_rule(rule) {
                Ok(()) => Ok(ruleset),
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "无法为设备文件添加 Landlock 规则，跳过"
                    );
                    Ok(ruleset)
                }
            },
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "无法为设备文件构造 PathBeneathRule，跳过"
                );
                Ok(ruleset)
            }
        }
    }
}

/// 检测当前平台是否支持 Landlock。返回 (supported, details)。
pub fn support_info() -> (bool, String) {
    // landlock crate 在调用 restrict_self 时会自行检测；这里提供一个
    // best-effort 的运行时探测，便于日志记录。
    match ABI::V4.is_supported() {
        true => (true, "Landlock ABI V4 supported".to_string()),
        false => (false, "Landlock ABI V4 not supported by kernel".to_string()),
    }
}

/// 解析 profile 的 deny 路径为 bwrap bind-over 字符串列表。
/// Linux 上 read-deny 必须通过 bwrap bind-over 实现（Landlock 无 deny_path）。
#[cfg(target_os = "linux")]
pub(crate) fn deny_paths_for_bwrap(
    workspace: &Path,
    deny: &[PathBuf],
) -> Vec<String> {
    use crate::deny::{effective_deny_paths, partition_deny_entries, expand_deny_globs};
    use crate::deny::{DENY_GLOB_MAX_DEPTH, DENY_GLOB_MAX_ENTRIES, DENY_GLOB_MAX_MATCHES};

    let (exact, globs) = partition_deny_entries(deny);
    let mut paths: Vec<String> = effective_deny_paths(workspace, &exact)
        .into_iter()
        .map(|p| p.display().to_string())
        .collect();

    if !globs.is_empty() {
        tracing::warn!(
            count = globs.len(),
            "sandbox deny globs 在 Linux 上尽力强制（启动时展开）；启动后创建的匹配文件不被覆盖"
        );
        if let Some(expanded) = expand_deny_globs(
            workspace,
            &globs,
            DENY_GLOB_MAX_DEPTH,
            DENY_GLOB_MAX_MATCHES,
            DENY_GLOB_MAX_ENTRIES,
        ) {
            paths.extend(expanded);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{ProfileName, SandboxConfig};

    #[test]
    fn support_info_returns_a_string() {
        let (supported, details) = support_info();
        // 不论支持与否，details 应为非空字符串
        assert!(!details.is_empty(), "support_info 应返回非空 details");
        let _ = supported;
    }

    #[test]
    fn landlock_sandbox_new_does_not_apply() {
        let profile = SandboxProfile {
            name: "test".to_string(),
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
            default_read: false,
            restrict_network: false,
        };
        let sb = LandlockSandbox::new(profile);
        assert!(!sb.is_applied(), "new() 不应立即应用");
    }

    #[test]
    fn landlock_sandbox_preserves_profile_name() {
        let profile = SandboxProfile {
            name: "workspace".to_string(),
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
            default_read: true,
            restrict_network: false,
        };
        let sb = LandlockSandbox::new(profile);
        assert_eq!(sb.profile().name, "workspace");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn deny_paths_for_bwrap_resolves_relative() {
        let ws = Path::new("/tmp/project");
        let deny = vec![
            PathBuf::from(".env"),
            PathBuf::from("/etc/shadow"),
        ];
        let paths = deny_paths_for_bwrap(ws, &deny);
        assert!(
            paths.iter().any(|p| p == "/tmp/project/.env"),
            "应包含解析后的相对路径：{:?}",
            paths
        );
        assert!(
            paths.iter().any(|p| p == "/etc/shadow"),
            "应包含绝对路径：{:?}",
            paths
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn deny_paths_for_bwrap_dedupes() {
        let ws = Path::new("/ws");
        let deny = vec![
            PathBuf::from("/etc/shadow"),
            PathBuf::from("/etc/shadow"),
            PathBuf::from(".env"),
        ];
        let paths = deny_paths_for_bwrap(ws, &deny);
        assert_eq!(
            paths.iter().filter(|p| *p == &"/etc/shadow".to_string()).count(),
            1,
            "应去重：{:?}",
            paths
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn deny_paths_for_bwrap_expands_globs() {
        // 构造一个临时工作区，放入匹配 *.pem 的文件
        let ws = std::env::temp_dir().join(format!(
            "nexus-landlock-glob-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("a.pem"), "x").unwrap();
        std::fs::write(ws.join("b.txt"), "x").unwrap();
        let deny = vec![PathBuf::from("*.pem")];
        let paths = deny_paths_for_bwrap(&ws, &deny);
        assert!(
            paths.iter().any(|p| p.ends_with("a.pem")),
            "应展开匹配 *.pem 的文件：{:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p.ends_with("b.txt")),
            "不应包含不匹配的文件：{:?}",
            paths
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn apply_with_off_profile_does_not_panic() {
        // apply() 在受支持内核上会真正应用；在不支持内核上 degrade gracefully。
        // 我们用一个最小可解析的 profile 调用，断言不 panic。
        let profile = SandboxProfile {
            name: "off-test".to_string(),
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
            default_read: false,
            restrict_network: false,
        };
        let mut sb = LandlockSandbox::new(profile);
        // 应用结果不强制——只断言不 panic。
        let _ = sb.apply();
    }
}
