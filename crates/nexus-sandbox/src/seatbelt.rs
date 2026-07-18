// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/profiles.rs 与 src/deny/mod.rs 的 Seatbelt 相关逻辑）。Nexus
// Agent 在此基础上重写：原版通过 nono crate 间接调用 macOS Seatbelt，本模块直接
// 生成 `.sb` profile 并通过 `sandbox-exec` 应用。
//
//! macOS Seatbelt 实现。
//!
//! Seatbelt 是 macOS 内核的沙箱框架。本模块将 [`crate::profile::SandboxProfile`]
//! 转换为 `.sb` profile 字符串，通过 `sandbox-exec` 应用到子进程。
//!
//! 与 Linux Landlock 不同，Seatbelt 支持 `deny` 子路径（通过 `(deny file-read*
//! (subpath ...))` / `(deny file-read* (literal ...))` 规则），所以无需 bwrap
//! bind-over。
//!
//! macOS 通过 `/tmp` -> `/private/tmp`、`/var` -> `/private/var`、`/etc` ->
//! `/private/etc` 的 firmlink 别名访问这些目录。一个 deny 规则必须同时覆盖
//! 原始路径和 `/private` 别名，否则可绕过。
//!
//! ```rust,no_run
//! use nexus_sandbox::profile::{ProfileName, SandboxConfig};
//! use nexus_sandbox::seatbelt::SeatbeltSandbox;
//! use std::path::Path;
//!
//! let workspace = Path::new("/Users/user/project");
//! let config = SandboxConfig::default();
//! let profile = ProfileName::Workspace.resolve_profile(workspace, &config).unwrap();
//! let mut sb = SeatbeltSandbox::new(profile);
//! sb.apply().expect("seatbelt apply failed");
//! ```

use std::path::{Path, PathBuf};

use crate::profile::SandboxProfile;

/// macOS Seatbelt 沙箱句柄。`new()` 不应用，调用 `apply()` 后才强制。
pub struct SeatbeltSandbox {
    profile: SandboxProfile,
    applied: bool,
}

impl SeatbeltSandbox {
    /// 创建 Seatbelt 沙箱管理器。调用 `apply()` 之前不强制任何限制。
    pub fn new(profile: SandboxProfile) -> Self {
        Self {
            profile,
            applied: false,
        }
    }

    /// 生成一个完整的 `.sb` profile 字符串。
    ///
    /// 该 profile 可被 `sandbox-exec -p <profile>` 应用。
    pub fn generate_profile(&self) -> String {
        let mut buf = String::with_capacity(2048);
        buf.push_str(";; Nexus Agent Seatbelt profile (auto-generated)\n");
        buf.push_str("(version 1)\n");
        buf.push_str("(deny default)\n");

        // 默认 read：授予对 / 的读权限
        if self.profile.default_read {
            buf.push_str("(allow file-read*\n");
            buf.push_str("  (subpath \"/\"))\n");
        }

        // 显式 read-only 路径
        for path in &self.profile.read_only {
            if !path.exists() {
                continue;
            }
            for form in macos_path_aliases(path) {
                if let Some(escaped) = escape_seatbelt_path(&form) {
                    buf.push_str(&format!(
                        "(allow file-read*\n  (subpath \"{escaped}\"))\n"
                    ));
                }
            }
        }

        // read-write 路径——预先创建可能不存在的目录（例如 ~/.nexus/）
        for path in &self.profile.read_write {
            if !path.exists() && std::fs::create_dir_all(path).is_err() {
                tracing::warn!(path = ?path, "read_write 路径不存在且无法创建，跳过");
                continue;
            }
            for form in macos_path_aliases(path) {
                if let Some(escaped) = escape_seatbelt_path(&form) {
                    buf.push_str(&format!(
                        "(allow file-read*\n  (subpath \"{escaped}\"))\n"
                    ));
                    buf.push_str(&format!(
                        "(allow file-write*\n  (subpath \"{escaped}\"))\n"
                    ));
                }
            }
        }

        // 设备特殊文件（/dev/null、/dev/tty 等）
        for dev in crate::workspace::DEVICE_FILES {
            let p = Path::new(dev);
            if !p.exists() {
                continue;
            }
            if let Some(escaped) = escape_seatbelt_path(p) {
                buf.push_str(&format!(
                    "(allow file-read*\n  (literal \"{escaped}\"))\n"
                ));
                buf.push_str(&format!(
                    "(allow file-write*\n  (literal \"{escaped}\"))\n"
                ));
            }
        }
        // 设备目录（虽然 Linux 上是 /dev/pts，macOS 上通常无需，但保持一致）
        for dev in crate::workspace::DEVICE_DIRS {
            let p = Path::new(dev);
            if p.exists() && p.is_dir() {
                if let Some(escaped) = escape_seatbelt_path(p) {
                    buf.push_str(&format!(
                        "(allow file-read*\n  (subpath \"{escaped}\"))\n"
                    ));
                    buf.push_str(&format!(
                        "(allow file-write*\n  (subpath \"{escaped}\"))\n"
                    ));
                }
            }
        }

        // deny 路径——Seatbelt 支持 subpath deny，直接生成规则
        // 关键：deny 规则在 allow 之后发出（Seatbelt 是 last-match 语义）
        for deny_path in &self.profile.deny {
            let canonical = std::fs::canonicalize(deny_path).unwrap_or_else(|_| deny_path.clone());
            let use_subpath = canonical.is_dir();
            for form in macos_path_aliases(deny_path) {
                let Some(escaped) = escape_seatbelt_path(&form) else {
                    tracing::warn!(
                        path = ?form,
                        "无法将 deny 路径转义为 Seatbelt filter，跳过（fail-open）"
                    );
                    continue;
                };
                let filter = if use_subpath {
                    format!("(subpath \"{escaped}\")")
                } else {
                    format!("(literal \"{escaped}\")")
                };
                // 读 deny
                buf.push_str(&format!("(deny file-read* {filter})\n"));
                // 写 deny（catch-all）
                buf.push_str(&format!("(deny file-write* {filter})\n"));
                // 具体写子动作 deny——确保 deny 在 workspace 内也胜出（last-match）
                for action in SEATBELT_WRITE_DENY_ACTIONS {
                    buf.push_str(&format!("(deny {action} {filter})\n"));
                }
            }
        }

        // 网络隔离
        if self.profile.restrict_network {
            buf.push_str(";; 网络隔离\n");
            buf.push_str("(deny network*)\n");
        }

        buf
    }

    /// 应用 Seatbelt 沙箱到当前进程。**仅在 macOS 上有意义**。
    ///
    /// 通过生成 `.sb` profile 并调用 `sandbox-exec` 应用。注意 `sandbox-exec`
    /// 通常用于子进程；对当前进程的"应用"实际是记录 profile 供后续
    /// `command_for_exec` 使用。
    ///
    /// 返回 `Ok(())` 表示 profile 生成成功；实际内核强制发生在 `command_for_exec`
    /// 调用 `sandbox-exec -p <profile> -- <cmd>` 时。
    pub fn apply(&mut self) -> anyhow::Result<()> {
        // 仅在 macOS 上做真实工作；其他平台是 no-op
        #[cfg(target_os = "macos")]
        {
            let _profile_str = self.generate_profile();
            self.applied = true;
            tracing::info!(
                profile = %self.profile.name,
                "Seatbelt 沙箱已配置（通过 sandbox-exec 应用到子进程）"
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            // 非 macOS 平台：Seatbelt 不可用，no-op
            tracing::debug!(
                "Seatbelt apply() 在非 macOS 平台上为 no-op（profile={}）",
                self.profile.name
            );
        }
        Ok(())
    }

    /// Seatbelt 是否已应用。
    pub fn is_applied(&self) -> bool {
        self.applied
    }

    /// 当前 profile。
    pub fn profile(&self) -> &SandboxProfile {
        &self.profile
    }

    /// 构造一个 `sandbox-exec` 命令，用当前 profile 沙箱化 `<command> <args>`。
    ///
    /// 调用方应 `cmd.spawn()` 或 `cmd.output()` 该结果。
    #[cfg(target_os = "macos")]
    pub fn command_for_exec(
        &self,
        command: &str,
        args: &[String],
    ) -> std::process::Command {
        let profile = self.generate_profile();
        let mut cmd = std::process::Command::new("sandbox-exec");
        cmd.arg("-p").arg(&profile).arg("--").arg(command);
        for a in args {
            cmd.arg(a);
        }
        cmd
    }
}

/// Seatbelt 写子动作 deny 列表。
///
/// `(deny file-write* ...)` 单独不够：宽 workspace `(allow file-write* (subpath <ws>))`
/// 在 last-match 语义下会胜出，留下被 deny 的路径仍可写。经验上，deny 每个具体
/// 写子动作（每个比 `file-write*` grant 更具体的）能让 deny 不论发出顺序都胜出，
/// 完全阻断 overwrite 和 relocation（rename/unlink）。
const SEATBELT_WRITE_DENY_ACTIONS: &[&str] = &[
    "file-write-data",
    "file-write-create",
    "file-write-unlink",
    "file-write-mode",
    "file-write-owner",
    "file-write-flags",
    "file-write-times",
    "file-write-setugid",
];

/// 转义路径用于 Seatbelt `(literal "...")` / `(subpath "...")` filter。
///
/// 拒绝所有控制字符（与 nono 的 escape_path 一致）——静默放行会导致目标路径
/// 与意图不同。
pub(crate) fn escape_seatbelt_path(path: &Path) -> Option<String> {
    let s = path.to_str()?;
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 为一个路径生成所有需要覆盖的 macOS 别名形式：原始路径、canonical 形式，
/// 以及每个的 `/private` firmlink 别名（例如 `/tmp/x` <-> `/private/tmp/x`）。
///
/// 这样一个 deny 规则无法通过别名绕过。
pub(crate) fn macos_path_aliases(path: &Path) -> Vec<PathBuf> {
    let mut forms: Vec<PathBuf> = vec![path.to_path_buf()];
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if canonical != path {
        forms.push(canonical);
    }
    let mut extended: Vec<PathBuf> = Vec::new();
    for form in forms.clone() {
        if let Some(alias) = toggle_private_prefix(&form)
            && !forms.contains(&alias)
            && !extended.contains(&alias)
        {
            extended.push(alias);
        }
    }
    forms.extend(extended);
    forms
}

/// 切换 macOS `/private` firmlink 前缀：`/tmp` <-> `/private/tmp`、
/// `/var` <-> `/private/var`、`/etc` <-> `/private/etc`。其他路径返回 `None`。
pub(crate) fn toggle_private_prefix(path: &Path) -> Option<PathBuf> {
    let s = path.to_str()?;
    for dir in ["tmp", "var", "etc"] {
        if let Some(rest) = s.strip_prefix(&format!("/private/{dir}"))
            && (rest.is_empty() || rest.starts_with('/'))
        {
            return Some(PathBuf::from(format!("/{dir}{rest}")));
        }
        if let Some(rest) = s.strip_prefix(&format!("/{dir}"))
            && (rest.is_empty() || rest.starts_with('/'))
        {
            return Some(PathBuf::from(format!("/private/{dir}{rest}")));
        }
    }
    None
}

/// 检测当前平台是否支持 Seatbelt。返回 (supported, details)。
pub fn support_info() -> (bool, String) {
    #[cfg(target_os = "macos")]
    {
        // 检查 sandbox-exec 是否在 PATH 中
        let has_exec = which_sandbox_exec();
        if has_exec {
            (true, "Seatbelt available via sandbox-exec".to_string())
        } else {
            (
                false,
                "sandbox-exec not found in PATH; Seatbelt unavailable".to_string(),
            )
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        (
            false,
            "Seatbelt is only available on macOS".to_string(),
        )
    }
}

#[cfg(target_os = "macos")]
fn which_sandbox_exec() -> bool {
    // 检查 /usr/bin/sandbox-exec（macOS 默认位置）
    Path::new("/usr/bin/sandbox-exec").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{ProfileName, SandboxConfig, SandboxProfile as Profile};

    fn test_profile() -> Profile {
        Profile {
            name: "test".to_string(),
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
            default_read: true,
            restrict_network: false,
        }
    }

    #[test]
    fn escape_handles_quotes_and_backslashes() {
        let p = Path::new("/tmp/foo\"bar");
        let escaped = escape_seatbelt_path(p).unwrap();
        assert!(escaped.contains("\\\""), "escaped: {escaped}");
        // 反斜杠也需转义
        let p2 = Path::new("/tmp/a\\b");
        let escaped2 = escape_seatbelt_path(p2).unwrap();
        assert!(escaped2.contains("\\\\"), "escaped: {escaped2}");
    }

    #[test]
    fn escape_rejects_control_chars() {
        assert!(escape_seatbelt_path(Path::new("/tmp/a\u{07}b")).is_none());
        assert!(escape_seatbelt_path(Path::new("/tmp/a\nb")).is_none());
    }

    #[test]
    fn toggle_private_prefix_handles_firmlinks() {
        assert_eq!(
            toggle_private_prefix(Path::new("/tmp/proj/.env")),
            Some(PathBuf::from("/private/tmp/proj/.env"))
        );
        assert_eq!(
            toggle_private_prefix(Path::new("/private/tmp/proj/.env")),
            Some(PathBuf::from("/tmp/proj/.env"))
        );
        assert_eq!(
            toggle_private_prefix(Path::new("/var/log/x")),
            Some(PathBuf::from("/private/var/log/x"))
        );
        assert_eq!(
            toggle_private_prefix(Path::new("/etc/passwd")),
            Some(PathBuf::from("/private/etc/passwd"))
        );
    }

    #[test]
    fn toggle_private_prefix_returns_none_for_non_firmlink() {
        assert_eq!(toggle_private_prefix(Path::new("/Users/x/.ssh")), None);
        assert_eq!(toggle_private_prefix(Path::new("/usr/local/bin")), None);
        assert_eq!(toggle_private_prefix(Path::new("/home/user")), None);
    }

    #[test]
    fn seatbelt_sandbox_new_does_not_apply() {
        let sb = SeatbeltSandbox::new(test_profile());
        assert!(!sb.is_applied(), "new() 不应立即应用");
    }

    #[test]
    fn seatbelt_sandbox_preserves_profile_name() {
        let mut profile = test_profile();
        profile.name = "workspace".to_string();
        let sb = SeatbeltSandbox::new(profile);
        assert_eq!(sb.profile().name, "workspace");
    }

    #[test]
    fn generate_profile_includes_default_read_when_enabled() {
        let sb = SeatbeltSandbox::new(test_profile());
        let p = sb.generate_profile();
        assert!(p.contains("(allow file-read*"), "应包含默认 read：\n{p}");
        assert!(p.contains("(subpath \"/\")"), "应授予 / 的 read：\n{p}");
    }

    #[test]
    fn generate_profile_omits_default_read_when_disabled() {
        let mut profile = test_profile();
        profile.default_read = false;
        let sb = SeatbeltSandbox::new(profile);
        let p = sb.generate_profile();
        // 没有 default_read 时，不应有 `(subpath "/")` 的 read-all 规则
        assert!(
            !p.contains("(allow file-read*\n  (subpath \"/\"))"),
            "不应包含 read-all：\n{p}"
        );
    }

    #[test]
    fn generate_profile_includes_deny_rules() {
        let mut profile = test_profile();
        profile.deny = vec![PathBuf::from("/etc/shadow")];
        let sb = SeatbeltSandbox::new(profile);
        let p = sb.generate_profile();
        assert!(p.contains("(deny file-read*"), "应包含 read deny：\n{p}");
        assert!(p.contains("(deny file-write*"), "应包含 write deny：\n{p}");
        // 具体写子动作
        assert!(p.contains("file-write-data"), "应包含具体写子动作：\n{p}");
        assert!(p.contains("file-write-unlink"), "应包含 unlink deny：\n{p}");
    }

    #[test]
    fn generate_profile_includes_network_deny_when_restricted() {
        let mut profile = test_profile();
        profile.restrict_network = true;
        let sb = SeatbeltSandbox::new(profile);
        let p = sb.generate_profile();
        assert!(p.contains("(deny network*)"), "应包含网络 deny：\n{p}");
    }

    #[test]
    fn generate_profile_omits_network_deny_when_unrestricted() {
        let profile = test_profile();
        let sb = SeatbeltSandbox::new(profile);
        let p = sb.generate_profile();
        assert!(!p.contains("(deny network*)"), "不应包含网络 deny：\n{p}");
    }

    #[test]
    fn support_info_returns_a_string() {
        let (supported, details) = support_info();
        // 不论支持与否，details 应为非空字符串
        assert!(!details.is_empty(), "support_info 应返回非空 details");
        let _ = supported;
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn apply_succeeds_on_macos() {
        let mut sb = SeatbeltSandbox::new(test_profile());
        sb.apply().expect("macOS apply 应成功");
        assert!(sb.is_applied());
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn apply_is_noop_off_macos() {
        let mut sb = SeatbeltSandbox::new(test_profile());
        // 非 macOS 平台 apply 是 no-op，但应返回 Ok
        sb.apply().expect("非 macOS apply 应为 no-op Ok");
        // applied 仍为 false（非 macOS 不真正应用）
        assert!(!sb.is_applied());
    }

    #[test]
    fn macos_path_aliases_includes_original_path() {
        let p = Path::new("/tmp/foo");
        let aliases = macos_path_aliases(p);
        assert!(
            aliases.iter().any(|a| a == p),
            "应包含原始路径：{:?}",
            aliases
        );
    }
}
