// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/profiles.rs）。Nexus Agent 在此基础上重写，移除 nono
// 依赖（landlock/seatbelt 在各自模块中独立实现），并将配置文件查找路径从
// ~/.grok 改为 ~/.nexus。
//
//! 沙箱 profile。内置：`workspace`、`devbox`、`read-only`、`strict`、`off`。
//! 自定义 profile 通过 `~/.nexus/sandbox.toml` 或 `.nexus/sandbox.toml` 定义。
//! 自定义 profile 的 `deny` 列表在两个平台上都内核强制（读 + 写/重命名）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::workspace::nexus_home;
#[cfg(unix)]
use crate::workspace::{
    essential_writable_paths, essential_writable_paths_minimal,
};

/// 一个已解析的、可转换为内核 capability 集的 sandbox profile。
#[derive(Debug, Clone)]
pub struct SandboxProfile {
    /// 显示名
    pub name: String,
    /// agent 可读（但不可写）的路径
    pub read_only: Vec<PathBuf>,
    /// agent 可读可写的路径
    pub read_write: Vec<PathBuf>,
    /// 完全拒绝的路径（覆盖 read_only/read_write）
    pub deny: Vec<PathBuf>,
    /// 是否默认对整个文件系统授予读访问
    pub default_read: bool,
    /// 子进程是否应被阻断网络
    pub restrict_network: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ProfileConfig {
    #[serde(default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub restrict_network: Option<bool>,
    #[serde(default)]
    pub read_only: Vec<String>,
    #[serde(default)]
    pub read_write: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SandboxConfig {
    #[serde(default)]
    pub profiles: HashMap<String, ProfileConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ProfileName {
    #[default]
    Workspace,
    Devbox,
    ReadOnly,
    Strict,
    Off,
    Custom(String),
}

impl ProfileName {
    pub fn restricts_network(&self) -> bool {
        matches!(self, Self::ReadOnly | Self::Strict)
    }

    /// 从 config 解析网络限制（处理 Custom profile）。
    pub fn restricts_network_resolved(&self, config: &SandboxConfig) -> bool {
        match self {
            Self::ReadOnly | Self::Strict => true,
            Self::Workspace | Self::Devbox | Self::Off => false,
            Self::Custom(name) => config
                .profiles
                .get(name)
                .and_then(|p| p.restrict_network)
                .unwrap_or(false),
        }
    }
}

impl std::fmt::Display for ProfileName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Workspace => write!(f, "workspace"),
            Self::Devbox => write!(f, "devbox"),
            Self::ReadOnly => write!(f, "read-only"),
            Self::Strict => write!(f, "strict"),
            Self::Off => write!(f, "off"),
            Self::Custom(name) => write!(f, "{name}"),
        }
    }
}

impl std::str::FromStr for ProfileName {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "workspace" => Ok(Self::Workspace),
            "devbox" => Ok(Self::Devbox),
            "read-only" | "readonly" => Ok(Self::ReadOnly),
            "strict" => Ok(Self::Strict),
            "off" | "none" => Ok(Self::Off),
            // 其他名字被视为自定义 profile 名。验证在尝试从配置加载时进行。
            other => Ok(Self::Custom(other.to_string())),
        }
    }
}

/// 从 `~/.nexus/sandbox.toml` 和 `.nexus/sandbox.toml` 加载沙箱配置。
///
/// 项目配置**只能添加**新的 profile 名。它不能重新定义已存在于全局配置
/// 中的名字——last-write-wins 会让恶意工作区掏空用户/企业自定义 profile
/// （例如清空 `deny` / 扩大 `read_write`），同时保留受信任的名字。
pub fn load_sandbox_config(workspace: &Path) -> SandboxConfig {
    let mut config = SandboxConfig::default();

    // 全局配置：~/.nexus/sandbox.toml
    let global_path = nexus_home().join("sandbox.toml");
    if let Some(global) = load_config_file(&global_path) {
        config = global;
    }

    // 项目配置：<workspace>/.nexus/sandbox.toml（仅可加）
    let project_path = workspace.join(".nexus").join("sandbox.toml");
    if let Some(project) = load_config_file(&project_path) {
        merge_project_profiles(&mut config, project);
    }

    config
}

pub fn sandbox_profile_conflicts(workspace: &Path) -> Vec<String> {
    let global = load_config_file(&nexus_home().join("sandbox.toml")).unwrap_or_default();
    let project =
        load_config_file(&workspace.join(".nexus").join("sandbox.toml")).unwrap_or_default();
    mismatched_profile_names(&global, &project)
}

fn mismatched_profile_names(global: &SandboxConfig, project: &SandboxConfig) -> Vec<String> {
    let mut names: Vec<String> = project
        .profiles
        .iter()
        .filter(|(name, _)| matches!(name.parse(), Ok(ProfileName::Custom(_))))
        .filter_map(|(name, project_profile)| {
            global
                .profiles
                .get(name)
                .filter(|global_profile| *global_profile != project_profile)
                .map(|_| name.to_owned())
        })
        .collect();
    names.sort_unstable();
    names
}

/// 将项目 profile 合并到 `config`。全局已定义的名字被忽略，因此工作区
/// 不能替换全局自定义 profile 的策略。
fn merge_project_profiles(config: &mut SandboxConfig, project: SandboxConfig) {
    for (name, profile) in project.profiles {
        config.profiles.entry(name).or_insert(profile);
    }
}

fn load_config_file(path: &Path) -> Option<SandboxConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    match toml::from_str(&content) {
        Ok(config) => Some(config),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "Failed to parse sandbox config");
            None
        }
    }
}

impl ProfileName {
    /// 解析 profile 为完全指定的 `SandboxProfile`（用于日志记录与 capability 构建）。
    pub fn resolve_profile(
        &self,
        workspace: &Path,
        config: &SandboxConfig,
    ) -> anyhow::Result<SandboxProfile> {
        self.resolve(workspace, config)
    }

    fn resolve(&self, workspace: &Path, config: &SandboxConfig) -> anyhow::Result<SandboxProfile> {
        match self {
            // 选中 `off` 在 resolve 之前处理（空 capability / apply 提前返回）。
            // 到这里几乎总是 `extends = "off"` / `"none"` 的自定义 profile——
            // 返回 Err，绝不 panic。
            Self::Off => anyhow::bail!(
                "sandbox profile 'off' cannot be resolved as a base profile; \
                 choose a built-in base (workspace, devbox, read-only, strict)"
            ),

            Self::Workspace => Ok(SandboxProfile {
                name: "workspace".to_string(),
                read_only: vec![],
                read_write: essential_writable_paths(workspace),
                deny: vec![],
                default_read: true,
                restrict_network: false,
            }),

            Self::Devbox => {
                // 一切可写除 /data。枚举顶级目录并跳过排除列表。不能授予 "/"
                // 因为 Landlock 没有 deny_path——子路径例外只能通过不授予父目录
                // 来实现。
                //
                // /data 在此从 read_write 中排除（不可写），但故意不是内核 deny：
                // 它通过 default_read 保持可读，其 Linux 写 deny 来自
                // bwrap_reexec_command(&["/data"]) re-exec，而非 profile.deny。
                // 保持 deny 为空可防止 extends devbox 的自定义 profile 把 /data
                // 继承到强制的内核 deny 集合中。
                let exclude = [PathBuf::from("/data")];
                let mut read_write = vec![workspace.to_path_buf()];
                if let Ok(entries) = std::fs::read_dir("/") {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if exclude.contains(&path) {
                            continue;
                        }
                        // 跳过虚拟文件系统（单独处理）
                        if matches!(path.to_str(), Some("/proc" | "/sys" | "/dev")) {
                            continue;
                        }
                        if path.is_dir() {
                            read_write.push(path);
                        }
                    }
                }
                Ok(SandboxProfile {
                    name: "devbox".to_string(),
                    read_only: vec![],
                    read_write,
                    deny: vec![],
                    default_read: true,
                    restrict_network: false,
                })
            }

            Self::ReadOnly => Ok(SandboxProfile {
                name: "read-only".to_string(),
                read_only: vec![],
                read_write: essential_writable_paths_minimal(),
                deny: vec![],
                default_read: true,
                restrict_network: true,
            }),

            Self::Strict => {
                let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/root"));
                let system_read: Vec<PathBuf> = [
                    "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/dev", "/proc", "/sys",
                    "/tmp",
                    // Landlock realpath: /etc/resolv.conf 经常 → /run/systemd/resolve/…
                    "/run",
                    // NSS/SSSD（及类似）在 /var 下——超出 resolv.conf 单独所需
                    "/var",
                    // macOS 专属路径（以下通过 exists() 过滤）
                    "/System",  // Security framework, dylibs, TLS 证书
                    "/Library", // 系统级框架
                    "/private", // /etc, /tmp, /var 符号链接后的真实路径
                ]
                .iter()
                .map(PathBuf::from)
                .filter(|p| p.exists())
                // ~/Library 用于 macOS keychain 访问（TLS 证书验证）
                .chain(std::iter::once(home.join("Library")))
                .filter(|p| p.exists())
                .chain(std::iter::once(workspace.to_path_buf()))
                .collect();

                Ok(SandboxProfile {
                    name: "strict".to_string(),
                    read_only: system_read,
                    read_write: essential_writable_paths(workspace),
                    deny: vec![],
                    default_read: false,
                    restrict_network: true,
                })
            }

            Self::Custom(name) => {
                let profile_config = config.profiles.get(name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "Custom sandbox profile '{name}' not found. \
                         Define it in ~/.nexus/sandbox.toml or .nexus/sandbox.toml:\n\n\
                         [profiles.{name}]\n\
                         extends = \"workspace\"\n\
                         read_only = [\"/data\"]\n"
                    )
                })?;

                // 若设置了 `extends`，则从基础 profile 开始
                let mut profile = if let Some(base_name) = &profile_config.extends {
                    let base: ProfileName = base_name.parse().map_err(|e: String| {
                        anyhow::anyhow!("Profile '{name}' extends invalid base: {e}")
                    })?;
                    if matches!(base, Self::Off) {
                        anyhow::bail!(
                            "Profile '{name}' extends '{base_name}', but 'off'/'none' \
                             is not a valid base profile"
                        );
                    }
                    if matches!(base, Self::Custom(_)) {
                        anyhow::bail!(
                            "Profile '{name}' extends '{base_name}', but custom profiles \
                             cannot extend other custom profiles (only built-ins)"
                        );
                    }
                    base.resolve(workspace, config)?
                } else {
                    // 默认：从 workspace 开始
                    Self::Workspace.resolve(workspace, config)?
                };

                profile.name = name.clone();

                // 应用自定义配置的覆盖
                if let Some(restrict_net) = profile_config.restrict_network {
                    profile.restrict_network = restrict_net;
                }

                // 添加自定义 read-only 路径
                for path_str in &profile_config.read_only {
                    profile.read_only.push(PathBuf::from(path_str));
                }

                // 添加自定义 read-write 路径
                for path_str in &profile_config.read_write {
                    profile.read_write.push(PathBuf::from(path_str));
                }

                // 添加自定义 deny 路径
                for path_str in &profile_config.deny {
                    profile.deny.push(PathBuf::from(path_str));
                }

                Ok(profile)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_profile_names() {
        assert_eq!(
            "workspace".parse::<ProfileName>().unwrap(),
            ProfileName::Workspace
        );
        assert_eq!(
            "devbox".parse::<ProfileName>().unwrap(),
            ProfileName::Devbox
        );
        assert_eq!(
            "read-only".parse::<ProfileName>().unwrap(),
            ProfileName::ReadOnly
        );
        assert_eq!(
            "readonly".parse::<ProfileName>().unwrap(),
            ProfileName::ReadOnly
        );
        assert_eq!(
            "strict".parse::<ProfileName>().unwrap(),
            ProfileName::Strict
        );
        assert_eq!("off".parse::<ProfileName>().unwrap(), ProfileName::Off);
        assert_eq!("none".parse::<ProfileName>().unwrap(), ProfileName::Off);
        // 未知名成为 Custom profile
        assert_eq!(
            "my-custom-profile".parse::<ProfileName>().unwrap(),
            ProfileName::Custom("my-custom-profile".to_string())
        );
    }

    #[test]
    fn display_roundtrip() {
        for profile in [
            ProfileName::Workspace,
            ProfileName::Devbox,
            ProfileName::ReadOnly,
            ProfileName::Strict,
            ProfileName::Off,
        ] {
            let s = profile.to_string();
            let parsed: ProfileName = s.parse().unwrap();
            assert_eq!(parsed, profile);
        }
    }

    #[test]
    fn display_custom() {
        let p = ProfileName::Custom("my-custom".to_string());
        assert_eq!(p.to_string(), "my-custom");
    }

    #[test]
    fn network_restriction() {
        assert!(!ProfileName::Workspace.restricts_network());
        assert!(!ProfileName::Devbox.restricts_network());
        assert!(ProfileName::ReadOnly.restricts_network());
        assert!(ProfileName::Strict.restricts_network());
        assert!(!ProfileName::Off.restricts_network());
    }

    #[test]
    fn mismatched_profile_names_reports_only_changed_custom_profiles() {
        let profile = |restrict_network| ProfileConfig {
            extends: Some("workspace".to_string()),
            restrict_network: Some(restrict_network),
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
        };
        let global = SandboxConfig {
            profiles: HashMap::from([
                ("dev".to_string(), profile(false)),
                ("same".to_string(), profile(false)),
            ]),
        };
        let project = SandboxConfig {
            profiles: HashMap::from([
                ("dev".to_string(), profile(true)),
                ("same".to_string(), profile(false)),
                ("project-only".to_string(), profile(true)),
                ("devbox".to_string(), profile(true)),
            ]),
        };

        assert_eq!(mismatched_profile_names(&global, &project), vec!["dev"]);
    }

    #[test]
    fn parse_toml_config() {
        let toml_str = r#"
[profiles.devbox]
extends = "workspace"
restrict_network = true
read_only = ["/data"]
deny = ["/data/private"]

[profiles.ci]
extends = "strict"
read_write = ["/tmp/ci-artifacts"]
"#;
        let config: SandboxConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.profiles.len(), 2);
        assert!(config.profiles.contains_key("devbox"));
        assert!(config.profiles.contains_key("ci"));
        assert_eq!(config.profiles["devbox"].read_only, vec!["/data"]);
        assert_eq!(config.profiles["devbox"].deny, vec!["/data/private"]);
    }

    #[test]
    fn project_cannot_redefine_global_profile() {
        // 全局 "secure" 带真实 deny 列表必须胜过项目的掏空。
        let mut config = SandboxConfig {
            profiles: HashMap::from([(
                "secure".to_string(),
                ProfileConfig {
                    extends: Some("workspace".to_string()),
                    restrict_network: Some(true),
                    read_only: vec![],
                    read_write: vec![],
                    deny: vec!["/home/user/.ssh".to_string()],
                },
            )]),
        };
        let project = SandboxConfig {
            profiles: HashMap::from([
                (
                    "secure".to_string(),
                    ProfileConfig {
                        extends: Some("workspace".to_string()),
                        restrict_network: Some(false),
                        read_only: vec![],
                        read_write: vec!["/".to_string()],
                        deny: vec![],
                    },
                ),
                (
                    "project-only".to_string(),
                    ProfileConfig {
                        extends: Some("workspace".to_string()),
                        restrict_network: None,
                        read_only: vec![],
                        read_write: vec![],
                        deny: vec!["./secrets".to_string()],
                    },
                ),
            ]),
        };

        merge_project_profiles(&mut config, project);

        assert_eq!(
            config.profiles["secure"].deny,
            vec!["/home/user/.ssh".to_string()],
            "全局 deny 必须保留"
        );
        assert_eq!(config.profiles["secure"].restrict_network, Some(true));
        assert!(
            config.profiles["secure"].read_write.is_empty(),
            "项目不得扩大全局 read_write"
        );
        assert!(
            config.profiles.contains_key("project-only"),
            "新的 project-only profile 名仍被允许"
        );
    }

    #[test]
    #[cfg(unix)]
    fn custom_extends_devbox_has_no_data_in_deny() {
        // 回归：devbox 通过本地列表排除 /data，而非 profile.deny，所以
        // extends devbox 的自定义 profile 不得把 /data 继承到内核 deny 集合
        // （那会错误地读 deny /data 并强制 fail-closed）。
        let workspace = std::env::current_dir().unwrap();
        let config = SandboxConfig {
            profiles: HashMap::from([(
                "mydev".to_string(),
                ProfileConfig {
                    extends: Some("devbox".to_string()),
                    restrict_network: None,
                    read_only: vec![],
                    read_write: vec![],
                    deny: vec![],
                },
            )]),
        };
        let profile = ProfileName::Custom("mydev".to_string());
        let resolved = profile.resolve_profile(&workspace, &config).unwrap();
        assert!(
            !resolved.deny.contains(&PathBuf::from("/data")),
            "extends devbox 的自定义 profile 不得把 /data 继承到 deny：{:?}",
            resolved.deny
        );
    }

    #[test]
    #[cfg(unix)]
    fn custom_profile_not_found() {
        let workspace = std::env::current_dir().unwrap();
        let config = SandboxConfig::default();

        let profile = ProfileName::Custom("nonexistent".to_string());
        let result = profile.resolve_profile(&workspace, &config);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found"), "Unexpected error: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn extends_off_returns_err_not_panic() {
        let workspace = std::env::current_dir().unwrap();
        let config = SandboxConfig {
            profiles: HashMap::from([(
                "broken".to_string(),
                ProfileConfig {
                    extends: Some("off".to_string()),
                    restrict_network: None,
                    read_only: vec![],
                    read_write: vec![],
                    deny: vec![],
                },
            )]),
        };
        let err = ProfileName::Custom("broken".to_string())
            .resolve_profile(&workspace, &config)
            .expect_err("extends=off 必须 Err");
        let msg = err.to_string();
        assert!(
            msg.contains("off") || msg.contains("none"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn resolve_off_returns_err_not_panic() {
        let workspace = std::env::current_dir().unwrap();
        let err = ProfileName::Off
            .resolve_profile(&workspace, &SandboxConfig::default())
            .expect_err("Off.resolve 必须 Err");
        assert!(err.to_string().contains("off"), "unexpected error: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn workspace_profile_resolves_with_workspace_in_read_write() {
        let ws = Path::new("/tmp/nexus-test-ws-xyz-12345");
        let profile = ProfileName::Workspace
            .resolve_profile(ws, &SandboxConfig::default())
            .expect("workspace 解析成功");
        assert_eq!(profile.name, "workspace");
        assert!(profile.default_read);
        assert!(!profile.restrict_network);
        assert!(
            profile.read_write.iter().any(|p| p == ws),
            "read_write 应包含 workspace：{:?}",
            profile.read_write
        );
    }

    #[test]
    #[cfg(unix)]
    fn read_only_profile_restricts_network_and_minimal_writable() {
        let profile = ProfileName::ReadOnly
            .resolve_profile(Path::new("/tmp/ws"), &SandboxConfig::default())
            .expect("read-only 解析成功");
        assert!(profile.restrict_network);
        // read-only profile 不应包含 workspace 自身在 read_write 中
        assert!(
            !profile
                .read_write
                .iter()
                .any(|p| p == Path::new("/tmp/ws")),
            "read-only 不应把 workspace 加入 read_write：{:?}",
            profile.read_write
        );
    }

    #[test]
    #[cfg(unix)]
    fn strict_profile_has_default_read_false() {
        let profile = ProfileName::Strict
            .resolve_profile(Path::new("/tmp/ws"), &SandboxConfig::default())
            .expect("strict 解析成功");
        assert!(!profile.default_read);
        assert!(profile.restrict_network);
    }
}
