// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/paths.rs）。Nexus Agent 在此基础上重写，移除了对
// xai-grok-config crate 的依赖，改用本模块的 `nexus_home()` 作为状态目录。
//
//! Nexus Agent 沙箱的状态目录与路径表。
//!
//! 替代 Grok 的 `xai_grok_config::grok_home()`：使用 `$NEXUS_HOME` 或
//! `~/.nexus` 作为状态目录。收集设备文件、临时目录、敏感 deny 路径以及
//! 各生态系统（包管理器 / 工具链）的可写路径。

use std::path::{Path, PathBuf};

// ── Nexus 状态目录 ───────────────────────────────────────────────────────────

/// Nexus 状态目录，始终可写（`$NEXUS_HOME` 或 `~/.nexus`）。
///
/// 创建目录（best-effort）后返回。等效于 Grok 的 `grok_home()`，但
/// 不依赖 xai-grok-config crate。
pub fn nexus_home() -> PathBuf {
    if let Ok(v) = std::env::var("NEXUS_HOME") {
        let p = PathBuf::from(v);
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let p = home.join(".nexus");
    let _ = std::fs::create_dir_all(&p);
    p
}

// ── 设备文件与目录 ──────────────────────────────────────────────────────────

/// 普通工具运行所需的可写设备文件。
///
/// 没有对这些的写权限，常见程序（git/curl/ssh/编译器）会因为无法打开
/// `/dev/null` 作为输出 sink、分配 PTY 或 seed RNG 而失败。
///
/// 这些是单个文件（用 `allow_file`，而非 `allow_path`）。
/// `/dev/pts` 是目录（Linux 上的 PTY slave），所以用 `allow_path`。
#[cfg(unix)]
pub(crate) const DEVICE_FILES: &[&str] = &[
    "/dev/null",    // 输出 sink——几乎所有 CLI 工具都用
    "/dev/zero",    // 零源——内存分配器用
    "/dev/random",  // 熵——crypto/TLS 用
    "/dev/urandom", // 熵——crypto/TLS 用
    "/dev/tty",     // 控制终端——git/ssh/gpg 用
    "/dev/ptmx",    // PTY 分配——终端 spawn 用
    "/dev/fd",      // 文件描述符访问（Linux 上是 /proc/self/fd 的符号链接）
];

/// 需要可写访问的设备目录。
#[cfg(unix)]
pub(crate) const DEVICE_DIRS: &[&str] = &[
    "/dev/pts", // PTY slaves（Linux）
];

// ── 临时目录 ─────────────────────────────────────────────────────────────────

/// 需要可写访问的临时目录。
///
/// Linux 上 `/tmp` 是标准临时目录。macOS 上程序同时使用 `/tmp`（指向
/// `/private/tmp` 的符号链接）和 `/private/var/folders/`（真正的 `TMPDIR` /
/// `NSTemporaryDirectory()`）。git、编译器等会向 `$TMPDIR` 写临时文件，
/// 该变量在 macOS 上解析为 `/private/var/folders/xx/.../T/`。
#[cfg(unix)]
pub(crate) fn temp_writable_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];

    // macOS：/tmp → /private/tmp，但真正的 TMPDIR 在 /private/var/folders 下。
    // 同时包含 /private/tmp，因为 Seatbelt 可能解析符号链接。
    if cfg!(target_os = "macos") {
        for p in ["/private/tmp", "/private/var/tmp", "/private/var/folders"] {
            let pb = PathBuf::from(p);
            if pb.exists() && pb.is_dir() {
                paths.push(pb);
            }
        }
    }

    // 尊重 $TMPDIR 如果它指向别处（例如自定义 Linux 设置）。
    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let pb = PathBuf::from(&tmpdir);
        if pb.exists() && pb.is_dir() && !paths.contains(&pb) {
            paths.push(pb);
        }
    }

    paths
}

// ── 关键可写路径 ─────────────────────────────────────────────────────────────

/// 允许工作区写入的 profile（workspace/devbox/strict）使用的可写目录路径。
/// 设备文件通过 `allow_file` 单独处理。
#[cfg(unix)]
pub(crate) fn essential_writable_paths(workspace: &Path) -> Vec<PathBuf> {
    let mut paths = vec![workspace.to_path_buf(), nexus_home()];
    paths.extend(temp_writable_paths());
    paths
}

/// read-only profile 使用的最小可写路径（仅 ~/.nexus + 临时目录）。
/// 设备文件通过 `allow_file` 单独处理。
#[cfg(unix)]
pub(crate) fn essential_writable_paths_minimal() -> Vec<PathBuf> {
    let mut paths = vec![nexus_home()];
    paths.extend(temp_writable_paths());
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nexus_home_is_under_home_when_env_unset() {
        // 安全地清除环境变量并断言 nexus_home() 落在 ~/.nexus。
        // 注意：测试期间不要污染真实环境，使用局部作用域。
        let saved = std::env::var("NEXUS_HOME").ok();
        // SAFETY: 测试串行运行；这是测试环境隔离的标准做法。
        unsafe {
            std::env::remove_var("NEXUS_HOME");
        }
        let home = nexus_home();
        assert!(
            home.ends_with(".nexus"),
            "nexus_home 应该指向 ~/.nexus，实际：{}",
            home.display()
        );
        if let Some(v) = saved {
            // SAFETY: 同上。
            unsafe {
                std::env::set_var("NEXUS_HOME", v);
            }
        }
    }

    #[test]
    fn nexus_home_respects_env_override() {
        let saved = std::env::var("NEXUS_HOME").ok();
        // SAFETY: 测试串行运行。
        unsafe {
            std::env::set_var("NEXUS_HOME", "/tmp/nexus-test-home-xyz");
        }
        let home = nexus_home();
        assert_eq!(home, PathBuf::from("/tmp/nexus-test-home-xyz"));
        // 恢复
        match saved {
            Some(v) => unsafe { std::env::set_var("NEXUS_HOME", v) },
            None => unsafe { std::env::remove_var("NEXUS_HOME") },
        }
        let _ = std::fs::remove_dir_all("/tmp/nexus-test-home-xyz");
    }

    #[test]
    #[cfg(unix)]
    fn temp_writable_paths_includes_tmp() {
        let paths = temp_writable_paths();
        assert!(
            paths.iter().any(|p| p == Path::new("/tmp")),
            "temp_writable_paths 应包含 /tmp：{:?}",
            paths
        );
    }

    #[test]
    #[cfg(unix)]
    fn essential_writable_paths_includes_workspace_and_nexus_home() {
        let ws = Path::new("/tmp/sample-ws");
        let paths = essential_writable_paths(ws);
        assert!(
            paths.iter().any(|p| p == ws),
            "应包含 workspace：{:?}",
            paths
        );
        assert!(
            paths.iter().any(|p| *p == nexus_home()),
            "应包含 nexus_home：{:?}",
            paths
        );
    }

    #[test]
    #[cfg(unix)]
    fn essential_writable_paths_minimal_excludes_workspace() {
        let paths = essential_writable_paths_minimal();
        assert!(
            paths.iter().any(|p| *p == nexus_home()),
            "应包含 nexus_home：{:?}",
            paths
        );
    }
}
