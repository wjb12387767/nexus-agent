// SPDX-License-Identifier: Apache-2.0
// 原始版权属于 xAI / Grok Build 项目（Apache-2.0，见 grok-build-main/crates/codegen/
// xai-grok-sandbox/src/deny/mod.rs 与 src/deny/glob.rs）。Nexus Agent 在此基础上
// 重写，移除对 nono::CapabilitySet 的依赖——本模块仅提供路径解析、glob 校验与
// 启动时展开，内核规则的注入由 landlock.rs / seatbelt.rs 各自完成。
//
//! 沙箱 profile 的内核强制 deny 路径。
//!
//! macOS：Seatbelt 平台规则在 `seatbelt.rs` 中通过 `sandbox-exec` 生成。
//! Linux：Landlock 不能 deny 一个已允许树的子路径；读 deny 通过 bwrap
//! bind-over 实现（见 `lib.rs::bwrap_reexec_command`）。
//!
//! 本模块负责所有平台共享的路径解析、glob 校验，以及 Linux 启动时的
//! glob 展开（mount namespace 不能在运行时匹配 glob）。

use std::path::{Path, PathBuf};

/// 是否为 glob 元字符（`*`、`?`、`[`）。Gitignore 风格。
pub(crate) fn is_glob(entry: &str) -> bool {
    entry.contains(['*', '?', '['])
}

/// 将 profile 的原始 deny 条目拆分为精确路径（由 literal/subpath 内核 deny
/// 流程处理）和 glob 模式。非 glob 条目原样返回，保持精确路径强制无回归。
pub(crate) fn partition_deny_entries(deny: &[PathBuf]) -> (Vec<PathBuf>, Vec<String>) {
    let mut exact = Vec::new();
    let mut globs = Vec::new();
    for entry in deny {
        match entry.to_str() {
            Some(s) if is_glob(s) => globs.push(s.to_string()),
            _ => exact.push(entry.clone()),
        }
    }
    (exact, globs)
}

/// 将 glob 拆分为字面根目录与 glob 尾巴（从第一个含元字符的组件起）。
/// 相对 glob 在 `workspace` 处生根（允许递归 `**`）；绝对 glob 在其前导
/// 非 glob 组件处生根（例如 `/home/**/.ssh` -> 根 `/home`，尾 `**/.ssh`）。
pub(crate) fn split_glob_root(workspace: &Path, glob: &str) -> (PathBuf, String) {
    let Some(abs) = glob.strip_prefix('/') else {
        return (workspace.to_path_buf(), glob.to_string());
    };
    let mut root = PathBuf::from("/");
    let mut tail: Vec<&str> = Vec::new();
    let mut in_tail = false;
    for comp in abs.split('/') {
        if in_tail {
            tail.push(comp);
        } else if is_glob(comp) {
            in_tail = true;
            tail.push(comp);
        } else if !comp.is_empty() {
            root.push(comp);
        }
    }
    (root, tail.join("/"))
}

/// 在两个平台上校验 deny glob，使得给定模式在所有地方解释相同或在所有
/// 地方被拒绝（绝不悄悄在 macOS 上弱强制）。在 macOS regex 翻译与 Linux
/// globset 展开之前运行：
///
/// 1. 拒绝 `{`/`}`/`\`：globset 支持花括号 alternation 与反斜杠转义，
///    但 Seatbelt 的运行时 regex 无法忠实地重现这些形式——在两个平台上
///    拒绝可保持两后端一致。需要 alternation 时写多个 deny 条目。
/// 2. 通过 `globset`（Linux matcher）编译，使畸形 glob（`a**b`、未闭合
///    `[`）在两个平台上 fail closed 一致。
pub(crate) fn validate_deny_glob(glob: &str) -> anyhow::Result<()> {
    if let Some(c) = glob.chars().find(|&c| matches!(c, '{' | '}' | '\\')) {
        anyhow::bail!(
            "deny glob {glob:?} uses unsupported metacharacter '{c}' \
             (brace alternation and backslash-escapes are not supported; \
             use separate deny entries)"
        );
    }
    // `**` 必须是整段路径组件（gitignore 语义）。非组件 `**`（例如 `a**b`）
    // 在 macOS 上翻译为 `.*`，但在 globset 中塌缩为 `*`——在两个平台上拒绝
    // 以防分歧。
    for comp in glob.split('/') {
        if comp.contains("**") && comp != "**" {
            anyhow::bail!(
                "deny glob {glob:?}: `**` must be its own path component (got segment {comp:?})"
            );
        }
    }
    // 字符类：仅支持可在 globset 上等价翻译的简单子集。拒绝字面 `]` 起始
    // 成员（`[]a]`）与任何嵌套 `[`——这覆盖 POSIX `[[:…:]]`——因为 globset
    // 与手写 regex 解析这些形式不同。（前导 `!`/`^` 取反是支持的。）
    let cc: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < cc.len() {
        if cc[i] != '[' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if matches!(cc.get(j), Some('!') | Some('^')) {
            j += 1;
        }
        if cc.get(j) == Some(&']') {
            anyhow::bail!("deny glob {glob:?}: a literal ']' as first class member is unsupported");
        }
        while j < cc.len() && cc[j] != ']' {
            if cc[j] == '[' {
                anyhow::bail!(
                    "deny glob {glob:?}: nested '[' / POSIX '[[:…:]]' classes are unsupported"
                );
            }
            j += 1;
        }
        // 未闭合类：让下方的 globset 构建统一报错。
        i = if j < cc.len() { j + 1 } else { cc.len() };
    }
    globset::GlobBuilder::new(glob)
        .literal_separator(true)
        .build()
        .map_err(|e| anyhow::anyhow!("invalid deny glob {glob:?}: {e}"))?;
    Ok(())
}

/// 将 deny 路径字符串从 profile 对 workspace 解析。相对路径与 `workspace`
/// 拼接；绝对路径原样使用。
pub(crate) fn resolve_deny_paths(workspace: &Path, deny: &[PathBuf]) -> Vec<PathBuf> {
    deny.iter()
        .map(|p| {
            if p.is_absolute() {
                p.clone()
            } else {
                workspace.join(p)
            }
        })
        .collect()
}

/// 解析、排序、去重 profile 的 deny 列表为待强制的规范路径集。
/// macOS Seatbelt（profile.rs）与 Linux bwrap（lib.rs）共用。
pub(crate) fn effective_deny_paths(workspace: &Path, deny: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = resolve_deny_paths(workspace, deny);
    paths.sort();
    paths.dedup();
    paths
}

/// 将已分区的 EXACT（非 glob）deny 条目解析为 bwrap bind 字符串：对
/// `workspace` 解析、排序、去重、字符串化。调用方传入 `partition_deny_entries`
/// 的精确切片。Linux bwrap 关注点（macOS 通过 Seatbelt deny，不用路径字符串）
/// —— 与 glob 的 `expand_deny_globs` 平行的精确路径版本。
#[cfg(target_os = "linux")]
pub(crate) fn exact_deny_path_strings(workspace: &Path, exact: &[PathBuf]) -> Vec<String> {
    effective_deny_paths(workspace, exact)
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}

/// 一个 deny 路径是否应被视作目录（Seatbelt `subpath` / bwrap dir-bind）
/// 而非单个文件：已存在的目录为 true，否则 false。macOS 与 Linux deny
/// 站点共享，防止两者悄悄分歧。
///
/// 限制：不存在的 deny 路径被视作单个文件（macOS 发 `(literal …)`）；
/// 若后来作为目录创建，其子项在 macOS 上不被覆盖。要 deny 整个目录树，
/// 请命名具体的已存在路径。
pub(crate) fn deny_path_is_dir(canonical: &Path) -> bool {
    canonical.is_dir()
}

/// Linux 启动时 deny-glob 展开的封顶值。mount namespace 不能在运行时
/// glob，因此 glob 在启动时一次性展开为已存在的匹配项；这些界限阻止
/// 过宽 glob（例如 `**/*`）炸掉 bind 列表或进行无界遍历。超过任一值则
/// fail closed（见 [`expand_deny_globs`]）。
#[cfg(target_os = "linux")]
pub(crate) const DENY_GLOB_MAX_DEPTH: usize = 64;
#[cfg(target_os = "linux")]
pub(crate) const DENY_GLOB_MAX_MATCHES: usize = 4096;
/// walk 在 fail closed 之前可访问的总树项数。限制大仓库上的启动延迟
/// （`max_matches` 限制匹配数，而非访问项数），使得匹配很少的宽 glob
/// 也不会每次启动都遍历无界树。
#[cfg(target_os = "linux")]
pub(crate) const DENY_GLOB_MAX_ENTRIES: usize = 200_000;

/// 分类展开 deny glob 时遇到的 walk 错误。权限错误意味着相同 uid 的
/// agent 同样被内核拒绝，因此跳过该子树不暴露任何东西；其他错误（瞬时
/// IO、fd 耗尽、race）可能隐藏可读匹配，因此是致命的——fail closed 而
/// 非弱强制。
#[cfg(target_os = "linux")]
fn deny_glob_walk_error_is_fatal(err: &ignore::Error) -> bool {
    match err.io_error() {
        Some(io) => io.kind() != std::io::ErrorKind::PermissionDenied,
        None => true,
    }
}

/// 将 deny GLOBS 展开为匹配的具体已存在路径，供 Linux bwrap bind-over
/// 使用。相对 glob 在 `workspace` 处锚定；绝对 glob 在其字面（非 glob）
/// 前缀处锚定。walk 禁用 gitignore/hidden 过滤（被 deny 的 secret 如
/// `.env` 或 `*.pem` 通常两者都是）且从不跟随符号链接（符号链接不得
/// 将其目标偷运进 deny 集合）。
///
/// 当 glob 畸形、walk 被 `max_depth` 截断、访问项超过 `max_entries`、
/// 匹配超过 `max_matches`、或 walk 遇到非权限错误时返回 `None`（fail
/// closed）——调用方因此拒绝启动而非弱强制或炸掉 bind 列表。权限错误
/// 被跳过（相同 uid 的 agent 同样被 OS 拒绝）。每个 fail-closed 原因
/// 都被记录，使拒绝能点名 glob（而非通用的 "install bubblewrap" 路径）。
///
/// 尽力而为：启动**之后**创建的、匹配 glob 的文件在 Linux 上**不**被
/// 覆盖。macOS Seatbelt 将同样的 glob 作为运行时 regex 强制，所以覆盖。
#[cfg(target_os = "linux")]
pub(crate) fn expand_deny_globs(
    workspace: &Path,
    globs: &[String],
    max_depth: usize,
    max_matches: usize,
    max_entries: usize,
) -> Option<Vec<String>> {
    use globset::{GlobBuilder, GlobSetBuilder};
    use ignore::WalkBuilder;
    use std::collections::BTreeSet;

    let fail = |reason: String| -> Option<Vec<String>> {
        tracing::error!(%reason, "sandbox deny-glob expansion failed; refusing to start");
        eprintln!("error: sandbox deny glob could not be enforced on Linux: {reason}");
        None
    };

    let ws = workspace.to_string_lossy().into_owned();
    let mut builder = GlobSetBuilder::new();
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    for glob in globs {
        if let Err(e) = validate_deny_glob(glob) {
            return fail(e.to_string());
        }
        let pattern = if glob.starts_with('/') {
            glob.clone()
        } else {
            format!("{}/{}", globset::escape(&ws), glob)
        };
        let Ok(compiled) = GlobBuilder::new(&pattern).literal_separator(true).build() else {
            return fail(format!("could not compile glob {glob:?}"));
        };
        builder.add(compiled);
        roots.insert(split_glob_root(workspace, glob).0);
    }
    let Ok(set) = builder.build() else {
        return fail("could not build glob set".to_string());
    };

    let mut matches: BTreeSet<String> = BTreeSet::new();
    let mut visited: usize = 0;
    for root in roots {
        if !root.exists() {
            continue;
        }
        let walker = WalkBuilder::new(&root)
            .max_depth(Some(max_depth))
            .standard_filters(false)
            .hidden(false)
            .follow_links(false)
            .build();
        for dent in walker {
            let dent = match dent {
                Ok(dent) => dent,
                Err(e) => {
                    if deny_glob_walk_error_is_fatal(&e) {
                        return fail(format!("walk error under a deny-glob root: {e}"));
                    }
                    tracing::warn!(error = %e, "skipping unreadable entry during deny-glob walk");
                    continue;
                }
            };
            visited += 1;
            if visited > max_entries {
                return fail(format!(
                    "walk visited over {max_entries} entries (glob too broad)"
                ));
            }
            if dent.depth() >= max_depth && dent.file_type().is_some_and(|ft| ft.is_dir()) {
                return fail(format!("tree deeper than the {max_depth}-level depth cap"));
            }
            let path = dent.path();
            if set.is_match(path) {
                let Some(s) = path.to_str() else {
                    return fail(format!("deny-glob match has a non-UTF8 path: {path:?}"));
                };
                matches.insert(s.to_owned());
                if matches.len() > max_matches {
                    return fail(format!("matched over {max_matches} files (glob too broad)"));
                }
            }
        }
    }
    Some(matches.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_glob_detects_metacharacters() {
        assert!(is_glob("**/.env"));
        assert!(is_glob("**/*.pem"));
        assert!(is_glob("secrets/**"));
        assert!(is_glob("a?b"));
        assert!(is_glob("[abc].txt"));
        // 精确路径绝不应被视作 glob（literal deny 不回归）
        assert!(!is_glob(".env"));
        assert!(!is_glob("src/server.pem"));
        assert!(!is_glob("/etc/shadow"));
    }

    #[test]
    fn partition_separates_globs_from_exact_paths() {
        let deny = vec![
            PathBuf::from(".env"),
            PathBuf::from("**/*.pem"),
            PathBuf::from("/etc/shadow"),
            PathBuf::from("secrets/**"),
        ];
        let (exact, globs) = partition_deny_entries(&deny);
        assert_eq!(
            exact,
            vec![PathBuf::from(".env"), PathBuf::from("/etc/shadow")]
        );
        assert_eq!(
            globs,
            vec!["**/*.pem".to_string(), "secrets/**".to_string()]
        );
    }

    #[test]
    fn split_glob_root_relative_vs_absolute() {
        let ws = Path::new("/ws");
        assert_eq!(
            split_glob_root(ws, "**/.env"),
            (PathBuf::from("/ws"), "**/.env".to_string())
        );
        assert_eq!(
            split_glob_root(ws, "/home/**/.ssh"),
            (PathBuf::from("/home"), "**/.ssh".to_string())
        );
    }

    #[test]
    fn validate_deny_glob_accepts_subset_rejects_rest() {
        // 支持子集（`*`、`?`、`**`、`[...]` 含 `[!a]`/`[^a]` 取反）
        for g in [
            "**/*.pem",
            "**/.env",
            "secrets/**",
            "[abc].txt",
            "[a-z].rs",
            "[!a]b",
            "[^a]b",
            "a?b",
            "/home/**/.ssh",
        ] {
            assert!(validate_deny_glob(g).is_ok(), "{g} 应被支持");
        }
        // 花括号 + 反斜杠在 macOS 与 globset 间分歧 -> 两平台都拒绝（fail closed）
        for g in ["**/*.{pem,key}", "a\\*b", "{a,b}"] {
            assert!(validate_deny_glob(g).is_err(), "{g} 应被拒绝");
        }
        // 字符类形式：在 globset 与 regex 引擎间解析不同
        for g in ["[]a]", "[[:alpha:]]", "[a[b]"] {
            assert!(
                validate_deny_glob(g).is_err(),
                "{g} 不支持的字符类应被拒绝"
            );
        }
        // 畸形 glob 在两平台 fail closed 一致
        for g in ["a**b", "**a", "[abc"] {
            assert!(
                validate_deny_glob(g).is_err(),
                "{g} 应作为畸形被拒绝"
            );
        }
    }

    #[test]
    fn resolve_deny_paths_relative() {
        let ws = Path::new("/tmp/project");
        let deny = vec![PathBuf::from(".env"), PathBuf::from("/etc/shadow")];
        let resolved = resolve_deny_paths(&ws, &deny);
        assert_eq!(resolved[0], PathBuf::from("/tmp/project/.env"));
        assert_eq!(resolved[1], PathBuf::from("/etc/shadow"));
    }

    #[test]
    fn effective_deny_paths_sorts_and_dedups() {
        let ws = Path::new("/ws");
        let deny = vec![
            PathBuf::from("/etc/shadow"),
            PathBuf::from(".env"),
            PathBuf::from("/etc/shadow"),
        ];
        let paths = effective_deny_paths(&ws, &deny);
        assert_eq!(paths.len(), 2, "应去重：{:?}", paths);
        assert!(
            paths.iter().any(|p| p == &PathBuf::from("/ws/.env")),
            "应包含 /ws/.env：{:?}",
            paths
        );
        assert_eq!(paths[1], PathBuf::from("/etc/shadow"), "应排序");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn exact_deny_path_strings_resolves_sorts_dedups() {
        let ws = PathBuf::from("/ws");
        let exact = vec![
            PathBuf::from("src/server.pem"),
            PathBuf::from(".env"),
            PathBuf::from("/etc/shadow"),
            PathBuf::from(".env"),
        ];
        let paths = exact_deny_path_strings(&ws, &exact);
        assert!(paths.iter().any(|p| p == "/ws/.env"), "{paths:?}");
        assert!(paths.iter().any(|p| p == "/ws/src/server.pem"), "{paths:?}");
        assert!(paths.iter().any(|p| p == "/etc/shadow"), "{paths:?}");
        let mut sorted = paths.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(paths, sorted, "必须排序+去重：{paths:?}");
        assert!(
            !paths.iter().any(|p| p.contains('*')),
            "无 glob：{paths:?}"
        );
    }

    // Linux 启动时展开 + fail-closed 封顶。gated 到 linux，因此只在 Linux CI lane 运行。
    #[cfg(target_os = "linux")]
    mod linux_expand {
        use super::*;

        struct TmpTree(PathBuf);
        impl Drop for TmpTree {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        fn tmp_tree(tag: &str) -> PathBuf {
            let p = std::env::temp_dir().join(format!(
                "nexus-deny-glob-ut-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            p
        }

        #[test]
        fn matches_nested_pem_and_dotenv_excludes_control() {
            let ws = tmp_tree("match");
            let _g = TmpTree(ws.clone());
            std::fs::create_dir_all(ws.join("sub/dir")).unwrap();
            std::fs::write(ws.join("sub/dir/key.pem"), "x").unwrap();
            std::fs::write(ws.join(".env"), "x").unwrap(); // hidden + 通常被 gitignore
            std::fs::write(ws.join("readable.txt"), "x").unwrap();
            let globs = vec!["**/*.pem".to_string(), "**/.env".to_string()];
            let out = expand_deny_globs(&ws, &globs, 64, 4096, 200_000).expect("应展开");
            assert!(
                out.iter().any(|p| p.ends_with("sub/dir/key.pem")),
                "{out:?}"
            );
            assert!(out.iter().any(|p| p.ends_with("/.env")), "{out:?}");
            assert!(!out.iter().any(|p| p.ends_with("readable.txt")), "{out:?}");
        }

        #[test]
        fn empty_when_nothing_matches() {
            let ws = tmp_tree("empty");
            let _g = TmpTree(ws.clone());
            std::fs::write(ws.join("a.txt"), "x").unwrap();
            let out = expand_deny_globs(&ws, &["**/*.pem".to_string()], 64, 4096, 200_000).unwrap();
            assert!(out.is_empty(), "{out:?}");
        }

        #[test]
        fn fails_closed_on_match_cap() {
            let ws = tmp_tree("matchcap");
            let _g = TmpTree(ws.clone());
            for i in 0..5 {
                std::fs::write(ws.join(format!("k{i}.pem")), "x").unwrap();
            }
            assert!(expand_deny_globs(&ws, &["**/*.pem".to_string()], 64, 2, 200_000).is_none());
        }

        #[test]
        fn fails_closed_on_depth_cap() {
            let ws = tmp_tree("depthcap");
            let _g = TmpTree(ws.clone());
            std::fs::create_dir_all(ws.join("a/b/c")).unwrap();
            std::fs::write(ws.join("a/b/c/k.pem"), "x").unwrap();
            // 目录位于深度封顶 -> 更深的匹配可能被隐藏 -> None
            assert!(expand_deny_globs(&ws, &["**/*.pem".to_string()], 1, 4096, 200_000).is_none());
        }

        #[test]
        fn rejects_unsupported_glob() {
            let ws = tmp_tree("reject");
            let _g = TmpTree(ws.clone());
            // 花括号与 macOS 一致被拒绝（fail closed）
            assert!(
                expand_deny_globs(&ws, &["**/*.{pem,key}".to_string()], 64, 4096, 200_000)
                    .is_none()
            );
        }
    }
}
