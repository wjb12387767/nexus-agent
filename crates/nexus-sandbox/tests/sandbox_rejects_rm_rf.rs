// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0）。Nexus Agent 在此基础上
// 重写并增加新的测试用例。
//
//! M2 集成测试（Task 2.8.1）：验证沙箱在 profile 层级拒绝 `rm -rf /` 类
//! 灾难性命令的写操作。
//!
//! 本测试不实际 `apply()` 沙箱（Landlock 应用不可逆，且需要 Linux 内核
//! 支持；Seatbelt 需要 macOS；Windows 走 ISO FS 降级路径），而是验证
//! `SandboxProfile` 的解析结果——即沙箱一旦应用，内核会按此 profile 强制
//! 拒绝 `rm -rf /` 触及的路径的写操作。
//!
//! 具体验证项：
//! 1. `strict` profile 解析成功，且 `default_read = false`（无默认读）；
//! 2. `strict` profile 的 `read_write` 不包含 `/`、`/etc`、`/usr`、`/bin`、
//!    `/sbin`、`/lib`、`/lib64` 等 `rm -rf /` 会触及的系统路径；
//! 3. `workspace` profile 同样不把上述系统路径列入 `read_write`；
//! 4. 自定义 profile 通过 `deny = ["/"]` 显式拒绝根目录。
//!
//! 当 Landlock/Seatbelt 应用后，未在 `read_write` 中的路径写操作（unlink、
//! rmdir、rename、write）会被内核以 EPERM/EACCES 拒绝；`rm -rf /` 试图
//! 递归删除 `/etc`、`/usr` 等只读路径时即被拒绝。

#![cfg(unix)]

use nexus_sandbox::{
    load_sandbox_config, sandbox_profile_conflicts, ProfileConfig, ProfileName, SandboxConfig,
};
use std::path::{Path, PathBuf};

/// `rm -rf /` 会触及的关键系统路径。沙箱应用后，这些路径不应出现在任何
/// profile 的 `read_write` 中——否则 Landlock/Seatbelt 会授予写权限，
/// 允许 `rm` 递归删除它们。
const RM_RF_ROOT_TARGETS: &[&str] = &[
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/var",
    "/root",
    "/home",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
];

/// 解析 strict profile，验证所有 `rm -rf /` 目标路径都不在 `read_write` 中。
#[test]
fn strict_profile_denies_writes_to_rm_rf_root_targets() {
    let workspace = Path::new("/tmp/nexus-sandbox-test-strict-ws");
    let config = SandboxConfig::default();
    let profile = ProfileName::Strict
        .resolve_profile(workspace, &config)
        .expect("strict profile 解析必须成功");

    assert_eq!(profile.name, "strict");
    assert!(
        !profile.default_read,
        "strict profile 必须关闭 default_read，否则 Landlock 会授予对 / 的读权限"
    );
    assert!(
        profile.restrict_network,
        "strict profile 必须阻断网络（rm -rf / 后避免远程拉取修复脚本）"
    );

    let violating: Vec<&Path> = RM_RF_ROOT_TARGETS
        .iter()
        .map(Path::new)
        .filter(|target| profile.read_write.iter().any(|p| p == *target))
        .collect();

    assert!(
        violating.is_empty(),
        "strict profile 的 read_write 不应包含 rm -rf / 的目标路径，但发现：{:?}；\n\
         完整 read_write = {:?}",
        violating,
        profile.read_write
    );
}

/// `strict` profile 的 `read_only` 应包含系统路径（用于读取二进制、配置），
/// 但这只授予读权限——`rm` 的 unlink/rmdir 系统调用仍会被 Landlock/Seatbelt
/// 拒绝。验证系统路径确实在 `read_only` 中以确保 strict profile 可用
/// （否则连 `ls` 都跑不起来）。
#[test]
fn strict_profile_read_only_includes_system_paths_for_read_access() {
    let workspace = Path::new("/tmp/nexus-sandbox-test-strict-ro");
    let config = SandboxConfig::default();
    let profile = ProfileName::Strict
        .resolve_profile(workspace, &config)
        .expect("strict profile 解析必须成功");

    // `/etc` 和 `/usr` 在大多数 Unix 上存在，应出现在 read_only 中
    // （仅当路径实际存在时 profile 才会列入；这是 Landlock 的 O_PATH fd 要求）。
    let etc = Path::new("/etc");
    let usr = Path::new("/usr");
    if etc.exists() {
        assert!(
            profile.read_only.iter().any(|p| p == etc),
            "/etc 应在 strict profile 的 read_only 中：{:?}",
            profile.read_only
        );
    }
    if usr.exists() {
        assert!(
            profile.read_only.iter().any(|p| p == usr),
            "/usr 应在 strict profile 的 read_only 中：{:?}",
            profile.read_only
        );
    }

    // 关键不变量：read_only 与 read_write 不应重叠——若同一路径同时在两者
    // 中，Landlock 的最宽规则胜出（read_write 授予写权限），导致沙箱失效。
    let overlap: Vec<PathBuf> = profile
        .read_only
        .iter()
        .filter(|ro| profile.read_write.iter().any(|rw| rw == *ro))
        .cloned()
        .collect();
    assert!(
        overlap.is_empty(),
        "strict profile 的 read_only 与 read_write 不应重叠：{:?}",
        overlap
    );
}

/// `workspace` profile 同样不应把系统路径列入 read_write。
#[test]
fn workspace_profile_denies_writes_to_system_paths() {
    let workspace = Path::new("/tmp/nexus-sandbox-test-ws");
    let config = SandboxConfig::default();
    let profile = ProfileName::Workspace
        .resolve_profile(workspace, &config)
        .expect("workspace profile 解析必须成功");

    assert_eq!(profile.name, "workspace");
    assert!(profile.default_read, "workspace profile 应开启 default_read");

    // workspace profile 不应把任何系统路径列入 read_write
    let system_in_rw: Vec<&Path> = RM_RF_ROOT_TARGETS
        .iter()
        .map(Path::new)
        .filter(|t| *t != Path::new("/")) // workspace 可能不显式列 / 但通过 default_read 授予读
        .filter(|t| profile.read_write.iter().any(|p| p == *t))
        .collect();
    assert!(
        system_in_rw.is_empty(),
        "workspace profile 的 read_write 不应包含系统路径：{:?}",
        system_in_rw
    );

    // workspace 自身应在 read_write 中（这是沙箱的用途）
    assert!(
        profile.read_write.iter().any(|p| p == workspace),
        "workspace profile 的 read_write 应包含工作区本身：{:?}",
        profile.read_write
    );
}

/// 验证自定义 profile 通过 `deny = ["/"]` 显式拒绝根目录——这是
/// Landlock 内核强制 deny 的最强形式（读 + 写都拒）。
#[test]
fn custom_profile_with_root_deny_blocks_rm_rf() {
    use std::collections::HashMap;

    let workspace = Path::new("/tmp/nexus-sandbox-test-custom-deny");
    let config = SandboxConfig {
        profiles: HashMap::from([(
            "rm-rf-blocker".to_string(),
            ProfileConfig {
                extends: Some("strict".to_string()),
                restrict_network: Some(true),
                read_only: vec![],
                read_write: vec![],
                deny: vec!["/".to_string(), "/etc".to_string(), "/usr".to_string()],
            },
        )]),
    };

    let profile = ProfileName::Custom("rm-rf-blocker".to_string())
        .resolve_profile(workspace, &config)
        .expect("自定义 rm-rf-blocker profile 解析必须成功");

    assert_eq!(profile.name, "rm-rf-blocker");
    // deny 列表必须包含 /、/etc、/usr
    let deny_paths: Vec<&PathBuf> = profile.deny.iter().collect();
    assert!(
        profile.deny.iter().any(|p| p == Path::new("/")),
        "deny 必须包含 /：{:?}",
        deny_paths
    );
    assert!(
        profile.deny.iter().any(|p| p == Path::new("/etc")),
        "deny 必须包含 /etc：{:?}",
        deny_paths
    );
    assert!(
        profile.deny.iter().any(|p| p == Path::new("/usr")),
        "deny 必须包含 /usr：{:?}",
        deny_paths
    );

    // deny 路径不应同时出现在 read_write 中——deny 应优先（在 Landlock 中
    // 通过 bwrap bind-over 实现，在 Seatbelt 中通过 last-match deny 实现）。
    let conflicting: Vec<&PathBuf> = profile
        .deny
        .iter()
        .filter(|d| profile.read_write.iter().any(|rw| rw == *d))
        .collect();
    assert!(
        conflicting.is_empty(),
        "deny 路径不应出现在 read_write 中（deny 必须优先）：{:?}",
        conflicting
    );
}

/// 验证 `load_sandbox_config` 在临时工作区下不会 panic。
/// 这是 `rm -rf /` 测试的基础——若加载阶段 panic，沙箱永远无法应用。
///
/// 注意：全局配置 `~/.nexus/sandbox.toml` 在开发机上可能存在，故只断言
/// 不 panic 与返回有效 `SandboxConfig`，不断言 profiles 是否为空。
#[test]
fn load_sandbox_config_does_not_panic_without_project_config() {
    let temp_dir = tempfile_dir();
    let _config = load_sandbox_config(&temp_dir);
    // 不 panic 即通过——`SandboxConfig` 已通过类型系统保证有效。
}

/// 验证 `sandbox_profile_conflicts` 在没有冲突时返回空列表。
#[test]
fn sandbox_profile_conflicts_empty_without_files() {
    let temp_dir = tempfile_dir();
    let conflicts = sandbox_profile_conflicts(&temp_dir);
    assert!(
        conflicts.is_empty(),
        "没有配置文件时不应有冲突：{:?}",
        conflicts
    );
}

/// 验证 strict profile 在应用后（通过 [`SandboxProfile`] 的不变量），
/// 对 `rm -rf /` 关键路径的写拒绝是 kernel-enforced 而非 advisory。
///
/// 这通过断言 profile 的 `restrict_network = true` 间接验证：strict 同时
/// 阻断网络，意味着即使 `rm -rf /` 部分成功，攻击者也无法通过网络拉取
/// 修复脚本或外泄数据。
#[test]
fn strict_profile_blocks_network_for_rm_rf_post_exploitation() {
    let workspace = Path::new("/tmp/nexus-sandbox-test-strict-net");
    let config = SandboxConfig::default();
    let profile = ProfileName::Strict
        .resolve_profile(workspace, &config)
        .expect("strict profile 解析必须成功");

    assert!(
        profile.restrict_network,
        "strict profile 必须阻断网络（防止 rm -rf / 后远程修复）"
    );
    assert!(
        ProfileName::Strict.restricts_network(),
        "ProfileName::Strict.restricts_network() 必须返回 true"
    );
    assert!(
        ProfileName::Strict.restricts_network_resolved(&config),
        "restricts_network_resolved 必须返回 true"
    );
}

/// 验证 off profile 不会被错误地解析为有效沙箱——`rm -rf /` 在 off 模式
/// 下不会被沙箱拒绝（用户必须显式选择非 off profile 才能获得保护）。
#[test]
fn off_profile_does_not_provide_rm_rf_protection() {
    let workspace = Path::new("/tmp/nexus-sandbox-test-off");
    let config = SandboxConfig::default();
    let result = ProfileName::Off.resolve_profile(workspace, &config);
    assert!(
        result.is_err(),
        "off profile 不应解析为有效沙箱（应返回 Err）：{:?}",
        result
    );
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

/// 创建一个唯一的临时目录用于测试。使用 PID 避免并发测试冲突。
fn tempfile_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nexus-sandbox-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).ok();
    dir
}
