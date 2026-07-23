// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/lib.rs）。Nexus Agent 在此基础上重写：移除 nono 依赖，
// 改为直接使用 landlock crate（Linux）、sandbox-exec（macOS）、pi-iso（Windows 降级）。
//
//! OS 级沙箱：Nexus Agent 移植自 Grok Build。
//!
//! 通过 [`SandboxManager`] 应用一次到进程启动期。覆盖进程内 `tokio::fs` 调用
//! 与子进程。网络在进程级保持开放（agent 需要 LLM API）；子进程网络按子进程
//! 通过 seccomp 阻断（Linux）。
//!
//! ## 平台支持
//!
//! | 平台      | 后端                              | 备注                                       |
//! |----------|----------------------------------|--------------------------------------------|
//! | Linux    | Landlock LSM（直接 `landlock` crate）| deny 通过 bwrap bind-over 实现            |
//! | macOS    | Seatbelt（`sandbox-exec`）         | 直接生成 `.sb` profile                     |
//! | Windows  | ISO FS（pi-iso PAL 降级）           | 仅工作区隔离，无内核强制 deny              |
//!
//! ```rust,no_run
//! use nexus_sandbox::{SandboxManager, ProfileName};
//! use std::path::Path;
//!
//! let workspace = Path::new("/home/user/project");
//! let mut sandbox = SandboxManager::new(ProfileName::Workspace, workspace);
//! sandbox.apply(workspace).expect("sandbox apply failed");
//! sandbox.install();
//! ```

pub mod deny;
pub mod profile;
pub mod violation;
pub mod workspace;

#[cfg(target_os = "linux")]
pub mod landlock;
#[cfg(target_os = "linux")]
pub mod seccomp;

#[cfg(target_os = "macos")]
pub mod seatbelt;

pub use profile::{
    ProfileConfig, ProfileName, SandboxConfig, SandboxProfile, load_sandbox_config,
    sandbox_profile_conflicts,
};
pub use violation::{SandboxEvent, SandboxEventType, SandboxLogger, SandboxMetrics};

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf as _;

/// 用于检测 bwrap re-exec 的环境变量。
const BWRAP_ENV_VAR: &str = "__NEXUS_INSIDE_BWRAP";

/// 当前进程是否运行在 bwrap 内（由 [`bwrap_reexec_command`] 设置）。
pub fn is_inside_bwrap() -> bool {
    std::env::var(BWRAP_ENV_VAR).is_ok()
}

// ── 全局沙箱状态 ──────────────────────────────────────────────────────────────

static SANDBOX: OnceLock<GlobalSandboxState> = OnceLock::new();
static CONFIGURED_PROFILE: OnceLock<String> = OnceLock::new();

struct GlobalSandboxState {
    profile: String,
    logger: SandboxLogger,
    applied: bool,
}

/// 当前配置的 sandbox profile 名（启动期记录，包含 `"off"`）。
pub fn configured_profile_name() -> Option<&'static str> {
    CONFIGURED_PROFILE.get().map(|s| s.as_str())
}

/// 记录启动期解析的 sandbox profile（包括 `"off"`）。
pub fn set_configured_profile(name: impl Into<String>) {
    let _ = CONFIGURED_PROFILE.set(name.into());
}

/// 沙箱是否已成功应用到当前进程。
pub fn is_active() -> bool {
    SANDBOX.get().is_some_and(|s| s.applied)
}

/// 当前活跃的 sandbox profile 名，未应用时为 `None`。
pub fn profile_name() -> Option<&'static str> {
    SANDBOX
        .get()
        .filter(|s| s.applied)
        .map(|s| s.profile.as_str())
}

/// 记录一条沙箱违规并立即 flush 到磁盘。沙箱未激活时为 no-op。
pub fn log_violation(target: &str, operation: &str) {
    if let Some(state) = SANDBOX.get() {
        state
            .logger
            .log(SandboxEvent::fs_violation(&state.profile, target, operation));
        let _ = state.logger.flush_to_disk();
    }
}

/// 将沙箱事件 flush 到磁盘。未初始化时为 no-op。
pub fn flush() {
    if let Some(state) = SANDBOX.get()
        && let Err(e) = state.logger.flush_to_disk()
    {
        tracing::warn!(error = %e, "Failed to flush sandbox events to disk");
    }
}

/// 违规计数器，沙箱未激活时为 `None`。
pub fn metrics() -> Option<&'static SandboxMetrics> {
    SANDBOX.get().map(|s| s.logger.metrics())
}

// ── SandboxManager ────────────────────────────────────────────────────────────

/// 管理沙箱生命周期。先 `apply()` 再 `install()`。
///
/// 在 Linux 上使用 Landlock；在 macOS 上使用 Seatbelt（通过 sandbox-exec）；
/// 在 Windows 上降级为 ISO FS 隔离（pi-iso PAL）。
pub struct SandboxManager {
    profile: ProfileName,
    logger: SandboxLogger,
    net_restricted: bool,
    applied: bool,
    /// 解析后的 profile（apply 后填充，供 install 时引用）。
    resolved: Option<SandboxProfile>,
}

impl SandboxManager {
    /// 创建沙箱管理器。`apply()` 之前不强制任何限制。
    pub fn new(profile: ProfileName, _workspace: &Path) -> Self {
        let net_restricted = profile.restricts_network();
        Self {
            profile,
            logger: SandboxLogger::new(),
            net_restricted,
            applied: false,
            resolved: None,
        }
    }

    /// 应用沙箱到当前进程。**不可逆**。
    ///
    /// 平台不支持时 graceful degrade（记录但不强制）。
    pub fn apply(&mut self, workspace: &Path) -> anyhow::Result<()> {
        if self.profile == ProfileName::Off {
            tracing::info!("Sandbox disabled (profile: off)");
            return Ok(());
        }

        let config = load_sandbox_config(workspace);
        let resolved = self.profile.resolve_profile(workspace, &config)?;
        self.net_restricted = self.profile.restricts_network_resolved(&config);

        #[cfg(target_os = "linux")]
        {
            let (supported, details) = landlock::support_info();
            if !supported {
                tracing::warn!(
                    details = %details,
                    "Landlock not supported on this platform, continuing without sandbox"
                );
                self.logger.log(SandboxEvent::apply_failed(
                    &self.profile.to_string(),
                    workspace,
                    &details,
                ));
                return Ok(());
            }
            let mut sb = landlock::LandlockSandbox::new(resolved.clone());
            match sb.apply() {
                Ok(_) => {
                    self.applied = true;
                    self.resolved = Some(resolved.clone());
                    self.logger.log(SandboxEvent::profile_applied(
                        &self.profile.to_string(),
                        workspace,
                        &resolved,
                    ));
                    tracing::info!(
                        profile = %self.profile,
                        workspace = %workspace.display(),
                        restrict_network = self.net_restricted,
                        "Landlock sandbox applied (kernel-enforced, irreversible)"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        profile = %self.profile,
                        error = %e,
                        "Landlock could not be applied, continuing without sandbox"
                    );
                    self.logger.log(SandboxEvent::apply_failed(
                        &self.profile.to_string(),
                        workspace,
                        &e,
                    ));
                }
            }
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            let (supported, details) = seatbelt::support_info();
            if !supported {
                tracing::warn!(
                    details = %details,
                    "Seatbelt not supported on this platform, continuing without sandbox"
                );
                self.logger.log(SandboxEvent::apply_failed(
                    &self.profile.to_string(),
                    workspace,
                    &details,
                ));
                return Ok(());
            }
            let mut sb = seatbelt::SeatbeltSandbox::new(resolved.clone());
            match sb.apply() {
                Ok(_) => {
                    self.applied = true;
                    self.resolved = Some(resolved.clone());
                    self.logger.log(SandboxEvent::profile_applied(
                        &self.profile.to_string(),
                        workspace,
                        &resolved,
                    ));
                    tracing::info!(
                        profile = %self.profile,
                        workspace = %workspace.display(),
                        restrict_network = self.net_restricted,
                        "Seatbelt sandbox applied (via sandbox-exec)"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        profile = %self.profile,
                        error = %e,
                        "Seatbelt could not be applied, continuing without sandbox"
                    );
                    self.logger.log(SandboxEvent::apply_failed(
                        &self.profile.to_string(),
                        workspace,
                        &e,
                    ));
                }
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            // Windows 降级路径：通过 pi-iso PAL 创建工作区的隔离视图。
            // 不提供内核强制 deny，仅工作区写入隔离。
            self.apply_windows_iso_fallback(workspace, &resolved)?;
            return Ok(());
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            tracing::info!(
                profile = %self.profile,
                "Sandbox enforcement unavailable on this platform"
            );
            let _ = (workspace, resolved);
            Ok(())
        }
    }

    /// Windows 降级路径：使用 pi-iso PAL 创建工作区的可写快照视图。
    ///
    /// 限制：不提供内核强制 deny 路径。仅做工作区文件级隔离——所有写入
    /// 落在 merged 视图，不影响 lower 真实工作区。
    #[cfg(target_os = "windows")]
    fn apply_windows_iso_fallback(
        &mut self,
        workspace: &Path,
        resolved: &SandboxProfile,
    ) -> anyhow::Result<()> {
        use pi_iso::{BackendKind, IsolationBackend};

        let backend = pi_iso::backend(BackendKind::native());
        let probe = backend.probe();
        if !probe.available {
            // P0 fix: do NOT silently degrade. When the user opted into
            // `sandbox.enabled=true` but the Windows ISO FS backend is
            // unavailable, surface a hard error so the TS layer can apply
            // `sandbox.fallbackBehavior` (error/warn/continue) explicitly
            // instead of running unprotected with no user-visible signal.
            let reason = probe.reason.as_deref().unwrap_or("unknown");
            tracing::warn!(
                reason = %reason,
                "Windows ISO FS backend unavailable; returning error (no silent degradation)"
            );
            self.logger.log(SandboxEvent::apply_failed(
                &self.profile.to_string(),
                workspace,
                reason,
            ));
            return Err(anyhow::anyhow!(
                "Windows ISO FS sandbox backend is not available. The agent will run WITHOUT \
                 sandboxing. To fix: (1) run in WSL2 for Landlock sandbox, (2) run in Docker \
                 for container isolation, or (3) set sandbox.enabled=false to acknowledge \
                 running unsandboxed."
            ));
        }

        // 创建 merged 视图路径——放在 nexus_home 下以 PID 区分。
        let merged = workspace::nexus_home()
            .join("sandbox-iso")
            .join(format!("pid-{}", std::process::id()));
        std::fs::create_dir_all(&merged).ok();

        let lower = workspace.to_path_buf();
        let backend_kind = BackendKind::native();
        let backend = pi_iso::backend(backend_kind);
        let start_result = backend.start(&lower, &merged);
        match start_result {
            Ok(()) => {
                self.applied = true;
                self.resolved = Some(resolved.clone());
                self.logger.log(SandboxEvent::profile_applied(
                    &self.profile.to_string(),
                    workspace,
                    resolved,
                ));
                tracing::info!(
                    profile = %self.profile,
                    workspace = %workspace.display(),
                    merged = %merged.display(),
                    "Windows ISO FS sandbox applied (pi-iso PAL fallback)"
                );
                Ok(())
            }
            Err(e) => {
                tracing::warn!(
                    profile = %self.profile,
                    error = %e,
                    "Windows ISO FS sandbox could not be applied"
                );
                self.logger.log(SandboxEvent::apply_failed(
                    &self.profile.to_string(),
                    workspace,
                    &e,
                ));
                Ok(())
            }
        }
    }

    /// 将沙箱状态存到全局，供会话期违规日志使用。
    pub fn install(self) {
        let _ = self.logger.flush_to_disk();
        let _ = SANDBOX.set(GlobalSandboxState {
            profile: self.profile.to_string(),
            logger: self.logger,
            applied: self.applied,
        });
    }

    /// 沙箱是否已成功应用。
    pub fn is_applied(&self) -> bool {
        self.applied
    }

    /// 子进程是否应被阻断网络。
    pub fn restrict_child_network(&self) -> bool {
        self.applied && self.net_restricted
    }

    /// 当前 profile 名。
    pub fn profile(&self) -> &ProfileName {
        &self.profile
    }

    /// 解析后的 profile（apply 后才有）。
    pub fn resolved(&self) -> Option<&SandboxProfile> {
        self.resolved.as_ref()
    }

    /// 沙箱事件日志记录器（`install()` 之前可用）。
    pub fn logger(&self) -> &SandboxLogger {
        &self.logger
    }
}

// ── bwrap re-exec（Linux）─────────────────────────────────────────────────────

/// 构造一个 bwrap 命令，re-exec 当前进程，使得 `deny_write` 路径只读挂载、
/// `deny_read` 路径被不可读的占位符 bind-over（读时 EPERM）。
///
/// 已在 bwrap 内时返回 `None`。调用方应 `cmd.exec()` 该结果。
#[cfg(target_os = "linux")]
pub fn bwrap_reexec_command(
    deny_write: &[&str],
    deny_read: &[&str],
) -> Option<std::process::Command> {
    if is_inside_bwrap() {
        return None;
    }
    let self_exe = std::env::current_exe().ok()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cmd = std::process::Command::new("bwrap");
    cmd.arg("--bind").arg("/").arg("/");
    for path in deny_write {
        if Path::new(path).exists() {
            cmd.arg("--ro-bind").arg(path).arg(path);
        }
    }
    if !deny_read.is_empty() {
        for path in deny_read {
            let Some(blocked) = bwrap_blocked_source_for_path(Path::new(path)) else {
                eprintln!(
                    "error: could not create bwrap placeholder for read-deny path {path}; \
                     refusing to start with a partial sandbox"
                );
                return None;
            };
            cmd.arg("--ro-bind").arg(&blocked).arg(path);
        }
    }
    cmd.arg("--dev-bind").arg("/dev").arg("/dev");
    cmd.arg("--proc").arg("/proc");
    cmd.env(BWRAP_ENV_VAR, "1");
    cmd.arg("--").arg(self_exe).args(args);
    Some(cmd)
}

/// 为 deny 路径选择文件 vs 目录占位符（已存在的目录需要目录 bind）。
#[cfg(target_os = "linux")]
fn bwrap_blocked_source_for_path(path: &Path) -> Option<PathBuf> {
    if deny::deny_path_is_dir(path) {
        bwrap_blocked_placeholder("sandbox-blocked-dir", true)
    } else {
        bwrap_blocked_placeholder("sandbox-blocked", false)
    }
}

/// chmod 一个占位符到 mode 000，使 bwrap bind-over 在读时返回 EPERM。
#[cfg(target_os = "linux")]
fn chmod_000(path: &Path) -> Option<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).ok()?.permissions();
    perms.set_mode(0o000);
    std::fs::set_permissions(path, perms).ok()?;
    Some(())
}

/// 零权限占位符（文件或目录），位于 `nexus_home` 下，bwrap bind-over 使用。
///
/// 占位符名以当前 PID 为后缀，避免并发 nexus 进程在共享路径上 race
/// create/remove/chmod（这可能导致 `None` 与被静默丢弃的 bind fail-open）。
#[cfg(target_os = "linux")]
fn bwrap_blocked_placeholder(name: &str, want_dir: bool) -> Option<PathBuf> {
    use std::fs::OpenOptions;
    let path = workspace::nexus_home().join(format!("{name}.{}", std::process::id()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    if path.exists() {
        if path.is_dir() == want_dir {
            chmod_000(&path)?;
            return Some(path);
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path).ok()?;
        } else {
            std::fs::remove_file(&path).ok()?;
        }
    }
    if want_dir {
        std::fs::create_dir(&path).ok()?;
    } else {
        OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .ok()?;
    }
    chmod_000(&path)?;
    Some(path)
}

// ── NAPI 接口 ─────────────────────────────────────────────────────────────────

use napi::bindgen_prelude::*;
use napi_derive::{module_init, napi};

/// NAPI 沙箱句柄。包装一个 [`SandboxManager`]，向 TS 侧暴露 exec/writeFile/readFile。
#[napi]
pub struct SandboxHandle {
    manager: SandboxManager,
    workspace: PathBuf,
}

/// 沙箱创建选项。
#[napi(object)]
pub struct SandboxOptions {
    /// 工作区路径（沙箱以此为根授予读写）。
    pub workspace: String,
    /// 自定义 profile 配置（仅当 profile="custom" 时使用）。
    /// 形如 `{ "extends": "workspace", "deny": [".env"] }`。
    pub custom_profile: Option<CustomProfileConfig>,
}

/// 自定义 profile 配置（镜像 Rust 侧 [`ProfileConfig`]）。
#[napi(object)]
pub struct CustomProfileConfig {
    /// 基础 profile 名（"workspace" | "devbox" | "read-only" | "strict"）。
    pub extends: Option<String>,
    /// 是否阻断子进程网络。
    pub restrict_network: Option<bool>,
    /// 只读路径列表。
    pub read_only: Vec<String>,
    /// 读写路径列表。
    pub read_write: Vec<String>,
    /// 拒绝路径列表（读 + 写都拒）。
    pub deny: Vec<String>,
}

/// 沙箱执行结果。
#[napi(object)]
pub struct SandboxExecResult {
    /// 退出码（0 = 成功）。
    pub exit_code: i32,
    /// stdout 内容（UTF-8）。
    pub stdout: String,
    /// stderr 内容（UTF-8）。
    pub stderr: String,
}

/// 创建一个沙箱句柄。
///
/// `profile` 可选值：`"workspace"` | `"devbox"` | `"read-only"` | `"strict"` | `"off"` | `"custom"`。
/// `"custom"` 时从 `opts.custom_profile` 读取配置。
#[napi]
pub fn create_sandbox(
    profile: String,
    opts: SandboxOptions,
) -> Result<SandboxHandle> {
    let profile_name: ProfileName = profile
        .parse()
        .map_err(|e: String| Error::from_reason(format!("invalid profile: {e}")))?;

    // 若是 custom，将 custom_profile 注入到 SandboxConfig 中。
    if matches!(profile_name, ProfileName::Custom(_)) {
        if let Some(custom) = opts.custom_profile.as_ref() {
            // 写入临时配置文件到 nexus_home/sandbox.toml（如果还不存在的话）
            // 这里采用简化方案：直接写入项目级 .nexus/sandbox.toml
            let workspace_path = PathBuf::from(&opts.workspace);
            let project_config_dir = workspace_path.join(".nexus");
            std::fs::create_dir_all(&project_config_dir).map_err(|e| {
                Error::from_reason(format!("create project config dir: {e}"))
            })?;
            let config_path = project_config_dir.join("sandbox.toml");

            // 仅在文件不存在时写入（不覆盖用户已有配置）
            if !config_path.exists() {
                let toml = render_custom_profile_toml(&profile_name.to_string(), custom);
                std::fs::write(&config_path, toml).map_err(|e| {
                    Error::from_reason(format!("write custom profile: {e}"))
                })?;
            }
        }
    }

    let workspace = PathBuf::from(&opts.workspace);
    let manager = SandboxManager::new(profile_name, &workspace);

    Ok(SandboxHandle {
        manager,
        workspace,
    })
}

/// 将 CustomProfileConfig 渲染为 TOML 字符串。
fn render_custom_profile_toml(name: &str, c: &CustomProfileConfig) -> String {
    let mut buf = String::new();
    buf.push_str(&format!("[profiles.{name}]\n"));
    if let Some(e) = &c.extends {
        buf.push_str(&format!("extends = \"{e}\"\n"));
    }
    if let Some(rn) = c.restrict_network {
        buf.push_str(&format!("restrict_network = {rn}\n"));
    }
    if !c.read_only.is_empty() {
        let items: Vec<String> = c.read_only.iter().map(|s| format!("\"{s}\"")).collect();
        buf.push_str(&format!("read_only = [{}]\n", items.join(", ")));
    }
    if !c.read_write.is_empty() {
        let items: Vec<String> = c.read_write.iter().map(|s| format!("\"{s}\"")).collect();
        buf.push_str(&format!("read_write = [{}]\n", items.join(", ")));
    }
    if !c.deny.is_empty() {
        let items: Vec<String> = c.deny.iter().map(|s| format!("\"{s}\"")).collect();
        buf.push_str(&format!("deny = [{}]\n", items.join(", ")));
    }
    buf
}

#[napi]
impl SandboxHandle {
    /// 应用沙箱（不可逆）。在 Linux 上应用 Landlock，macOS 上应用 Seatbelt，
    /// Windows 上降级为 ISO FS 隔离。
    #[napi]
    pub fn apply(&mut self) -> Result<()> {
        self.manager
            .apply(&self.workspace)
            .map_err(|e| Error::from_reason(format!("sandbox apply: {e}")))
    }

    /// 沙箱是否已应用。
    #[napi(getter)]
    pub fn is_applied(&self) -> bool {
        self.manager.is_applied()
    }

    /// 当前 profile 名。
    #[napi(getter)]
    pub fn profile_name(&self) -> String {
        self.manager.profile().to_string()
    }

    /// 子进程是否应被阻断网络。
    #[napi(getter)]
    pub fn restrict_child_network(&self) -> bool {
        self.manager.restrict_child_network()
    }

    /// 在沙箱内执行一个命令。
    ///
    /// Linux 上通过 `pre_exec` 安装 seccomp 网络过滤器（当 `restrict_child_network` 为 true）。
    /// macOS 上通过 `sandbox-exec -p <profile> -- <cmd>` 执行。
    /// Windows 上直接执行（ISO FS 已隔离工作区）。
    #[napi]
    pub async fn exec(
        &self,
        command: String,
        args: Vec<String>,
    ) -> Result<SandboxExecResult> {
        let workspace = self.workspace.clone();
        let restrict_net = self.manager.restrict_child_network();
        let resolved = self.manager.resolved().cloned();

        tokio::task::spawn_blocking(move || {
            run_sandboxed_command(&command, &args, &workspace, restrict_net, resolved.as_ref())
        })
        .await
        .map_err(|e| Error::from_reason(format!("exec join: {e}")))?
    }

    /// 在沙箱内写入文件（受 profile 限制）。
    #[napi]
    pub async fn write_file(
        &self,
        path: String,
        content: String,
    ) -> Result<()> {
        let workspace = self.workspace.clone();
        tokio::task::spawn_blocking(move || {
            let resolved_path = resolve_path_in_workspace(&workspace, &path);
            std::fs::write(&resolved_path, content.as_bytes())
                .map_err(|e| Error::from_reason(format!("write_file {}: {e}", resolved_path.display())))
        })
        .await
        .map_err(|e| Error::from_reason(format!("write_file join: {e}")))?
    }

    /// 在沙箱内读取文件（受 profile 限制）。
    #[napi]
    pub async fn read_file(&self, path: String) -> Result<String> {
        let workspace = self.workspace.clone();
        tokio::task::spawn_blocking(move || {
            let resolved_path = resolve_path_in_workspace(&workspace, &path);
            let bytes = std::fs::read(&resolved_path)
                .map_err(|e| Error::from_reason(format!("read_file {}: {e}", resolved_path.display())))?;
            String::from_utf8(bytes)
                .map_err(|e| Error::from_reason(format!("read_file UTF-8 decode: {e}")))
        })
        .await
        .map_err(|e| Error::from_reason(format!("read_file join: {e}")))?
    }
}

/// 解析路径：相对路径相对于工作区，绝对路径原样使用。
fn resolve_path_in_workspace(workspace: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        workspace.join(p)
    }
}

/// 在沙箱内执行命令。平台分发：
/// - macOS：通过 sandbox-exec 调用
/// - Linux：通过 pre_exec 安装 seccomp（当 restrict_net 为 true）
/// - Windows：直接执行（ISO FS 已隔离）
fn run_sandboxed_command(
    command: &str,
    args: &[String],
    _workspace: &Path,
    restrict_net: bool,
    resolved: Option<&SandboxProfile>,
) -> Result<SandboxExecResult> {
    #[cfg(target_os = "macos")]
    {
        if let Some(profile) = resolved {
            let sb = seatbelt::SeatbeltSandbox::new(profile.clone());
            let mut cmd = sb.command_for_exec(command, args);
            let output = cmd
                .output()
                .map_err(|e| Error::from_reason(format!("sandbox-exec: {e}")))?;
            return Ok(SandboxExecResult {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new(command);
        cmd.args(args);
        if restrict_net {
            // SAFETY: pre_exec 在 fork 之后、exec 之前运行；install_child_network_filter
            // 是 async-signal-safe 的（仅 prctl + BPF install）。
            unsafe {
                cmd.pre_exec(|| {
                    if crate::seccomp::install_child_network_filter().is_err() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            "seccomp filter install failed",
                        ));
                    }
                    Ok(())
                });
            }
        }
        let output = cmd
            .output()
            .map_err(|e| Error::from_reason(format!("exec {command}: {e}")))?;
        return Ok(SandboxExecResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new(command);
        cmd.args(args);
        let output = cmd
            .output()
            .map_err(|e| Error::from_reason(format!("exec {command}: {e}")))?;
        return Ok(SandboxExecResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (command, args, restrict_net, resolved);
        Err(Error::from_reason(
            "sandbox exec not supported on this platform",
        ))
    }
}

/// 模块初始化：仅日志记录。NAPI 加载时调用。
#[module_init]
fn init_nexus_sandbox() {
    tracing::debug!("nexus-sandbox NAPI module loaded");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_manager_new_does_not_apply() {
        let ws = Path::new("/tmp/test-ws");
        let m = SandboxManager::new(ProfileName::Workspace, ws);
        assert!(!m.is_applied());
        assert!(!m.restrict_child_network());
        assert!(matches!(m.profile(), ProfileName::Workspace));
    }

    #[test]
    fn sandbox_manager_off_profile_does_not_apply() {
        let ws = Path::new("/tmp/test-ws");
        let mut m = SandboxManager::new(ProfileName::Off, ws);
        // apply on Off profile should return Ok without applying
        let result = m.apply(ws);
        assert!(result.is_ok(), "apply with Off profile should Ok");
        assert!(!m.is_applied(), "Off profile should not set applied");
    }

    #[test]
    fn resolve_path_in_workspace_handles_relative_and_absolute() {
        let ws = Path::new("/home/user/project");
        assert_eq!(
            resolve_path_in_workspace(ws, "src/index.ts"),
            PathBuf::from("/home/user/project/src/index.ts")
        );
        assert_eq!(
            resolve_path_in_workspace(ws, "/etc/passwd"),
            PathBuf::from("/etc/passwd")
        );
    }

    #[test]
    fn render_custom_profile_toml_includes_all_fields() {
        let custom = CustomProfileConfig {
            extends: Some("workspace".to_string()),
            restrict_network: Some(true),
            read_only: vec!["/data".to_string()],
            read_write: vec!["/tmp/out".to_string()],
            deny: vec![".env".to_string()],
        };
        let toml = render_custom_profile_toml("myprofile", &custom);
        assert!(toml.contains("[profiles.myprofile]"), "{toml}");
        assert!(toml.contains("extends = \"workspace\""), "{toml}");
        assert!(toml.contains("restrict_network = true"), "{toml}");
        assert!(toml.contains("\"/data\""), "{toml}");
        assert!(toml.contains("\"/tmp/out\""), "{toml}");
        assert!(toml.contains("\".env\""), "{toml}");
    }

    #[test]
    fn render_custom_profile_toml_minimal() {
        let custom = CustomProfileConfig {
            extends: None,
            restrict_network: None,
            read_only: vec![],
            read_write: vec![],
            deny: vec![],
        };
        let toml = render_custom_profile_toml("minimal", &custom);
        assert!(toml.contains("[profiles.minimal]"), "{toml}");
        // 没有可选字段时不应有对应行
        assert!(!toml.contains("extends"), "{toml}");
        assert!(!toml.contains("restrict_network"), "{toml}");
        assert!(!toml.contains("read_only"), "{toml}");
        assert!(!toml.contains("read_write"), "{toml}");
        assert!(!toml.contains("deny"), "{toml}");
    }

    #[test]
    fn is_inside_bwrap_is_false_when_env_unset() {
        // 在测试环境中通常未设置 BWRAP_ENV_VAR
        let saved = std::env::var(BWRAP_ENV_VAR).ok();
        // SAFETY: 测试串行运行。
        unsafe {
            std::env::remove_var(BWRAP_ENV_VAR);
        }
        assert!(!is_inside_bwrap());
        if let Some(v) = saved {
            // SAFETY: 同上。
            unsafe {
                std::env::set_var(BWRAP_ENV_VAR, v);
            }
        }
    }

    #[test]
    fn is_inside_bwrap_is_true_when_env_set() {
        let saved = std::env::var(BWRAP_ENV_VAR).ok();
        // SAFETY: 测试串行运行。
        unsafe {
            std::env::set_var(BWRAP_ENV_VAR, "1");
        }
        assert!(is_inside_bwrap());
        match saved {
            Some(v) => unsafe { std::env::set_var(BWRAP_ENV_VAR, v) },
            None => unsafe { std::env::remove_var(BWRAP_ENV_VAR) },
        }
    }

    #[test]
    fn set_and_get_configured_profile() {
        // 使用唯一名避免与并行测试冲突
        let name = format!("test-profile-{}", std::process::id());
        set_configured_profile(name.clone());
        // OnceLock 只能设置一次——若已设置过则 set 失败（被忽略）
        // 此测试仅验证函数不 panic
        let _ = configured_profile_name();
    }
}
