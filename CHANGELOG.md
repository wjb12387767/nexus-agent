# Changelog

All notable changes to Nexus Agent are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(with a `-prerelease` suffix during the alpha/beta phase).

## [Unreleased]

### Added — Hardening layer

Three capabilities that close known gaps in the upstream agents (omp / Grok
Build / OpenClaude):

- **Bash AST security analysis** (`packages/nexus-bash-ast/` +
  `crates/pi-natives/src/bash_ast.rs`): tree-sitter-bash AST allowlist layered
  ahead of the legacy 13-regex bash approver. Ports OpenClaude's security
  walker algorithm (`DANGEROUS_TYPES` set, `varScope` tracking, `declare -n`
  nameref detection, pipeline scope snapshot semantics) and re-implements it
  to operate on plain JSON `BashNode` structures produced by Rust
  `tree-sitter-bash` via NAPI (no `web-tree-sitter` WASM dependency).
  Fail-closed: AST parse timeout (50 ms) / node budget (50 000) / failure
  falls back to the regex approver. Toggle with `bash.astSecurity` (default
  `true`).
- **Doom loop detection** (`packages/agent/src/doom-loop-detector.ts`):
  sliding-window detector (windowSize=10, threshold=3) that flags repeated
  identical `(toolName, argsSignature)` calls across turns and emits a
  `logger.warn` nudge. `argsSignature` is a stable recursive-key-sorted JSON
  serialization that treats `{a:1,b:2}` and `{b:2,a:1}` as identical.
  Orthogonal to `MAX_SOFT_TOOL_ESCALATIONS` (soft-requirement cap) and
  `noopLoopGuard` (hashline no-op). Toggle with
  `doomLoopDetection: { enabled, threshold, windowSize }`.
- **Destructive regression suite**
  (`packages/coding-agent/test/integration/destructive-regression.test.ts`):
  end-to-end tests covering (1) sandbox rejects out-of-workspace write +
  checkpoint restore, (2) reflink CoW snapshot isolation, (3) bash AST +
  sandbox dual defense against `eval "rm -rf /"`, (4) compaction does not
  break checkpoint rewind. Skips on Windows / when NAPI modules are absent.
- **Walker unit tests** (`packages/nexus-bash-ast/test/walker.test.ts`): 29
  tests covering 14 attack vectors (`declare -n`, `eval`, `trap`, `enable`,
  `source`, `.`, `exec`, `command eval`, `bash -c`, `$(...)`, `rm -rf /`,
  `cat <(...)`, `=cmd`, `~[name]`), 10 normal commands, 5 edge cases.
- **DoomLoopDetector unit tests** (`packages/agent/test/doom-loop-detector.test.ts`):
  19 tests covering spec scenarios (consecutive same call / different args /
  reset after break) + boundary cases (sliding window, threshold=1,
  enabled=false, auto-reset after trigger) + `normalizeArgs` stability.
- **CI matrix**: added `bash-ast: on/off` dimension (2 representative combos)
  and two new jobs — `nexus_bash_ast_test` (Rust + TS) and
  `nexus_destructive_regression` (Linux only).

### Attribution

- Bash AST security walker algorithm adapted from OpenClaude's
  `src/utils/bash/ast.ts` (MIT). See
  [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for full attribution.

## [1.0.0-beta] - 2026-07-18

The "fusion complete" release: all nine milestones (M0–M9) shipped. Nexus now
fuses omp's tool layer, Grok Build's OS-level sandbox and rollback, and
OpenClaude's gRPC + VS Code + per-agent routing on a single engineering base,
with a CI matrix and release pipeline that cover all three OSes.

### Added — M2 (Grok OS sandbox port)

- **`crates/nexus-sandbox/`** Rust crate providing OS-level filesystem
  isolation, ported from Grok Build:
  - **Landlock** backend on Linux (kernel ≥ 5.13) — restricts
    `read_file` / `write_file` / `remove_file` / `make_dir` / `remove_dir`
    syscalls to the workspace.
  - **Seatbelt** backend on macOS — generates a `.sb` profile that mirrors
    the Landlock coverage.
  - **seccomp** network isolation + violation logging (Linux only).
  - **Profile** abstraction: `Workspace` (default) and `Custom` (with a
    caller-supplied path whitelist).
  - 5+ unit tests per backend verifying workspace-scoped IO is allowed and
    escapes are rejected (including `rm -rf /`).
- **`packages/nexus-sandbox/`** TS package exposing the crate via napi-rs:
  `createSandbox({ profile, workspaceRoot, violationPolicy })` returns a
  `SandboxHandle` with `exec`, `writeFile`, `readFile` methods.
- **Bash tool integration**: `packages/coding-agent/src/tools/bash.ts` now
  routes through the sandbox when `config.sandbox.enabled = true`.
- **Configuration**: `sandbox.enabled` / `sandbox.profile` /
  `sandbox.violationPolicy` added to `config.json`.
- **Windows fallback**: when Landlock/Seatbelt are unavailable, Nexus falls
  back to ISO FS (Projected FS) isolation. Limitations documented in
  [`docs/user-guide.md`](./docs/user-guide.md#沙箱与回滚).

### Added — M3 (Grok checkpoint/rollback port)

- **`crates/nexus-checkpoint/`** Rust crate providing file-state snapshots,
  ported from Grok Build's `xai-grok-workspace`:
  - `checkpoint_store` — content-addressed (file hash) incremental storage.
  - `swap_policy` — LRU + size cap (default 1 GB).
  - `file_state` — mtime + hash index for fast change detection.
  - **ISO FS reflink optimization**: on btrfs / APFS, checkpoints use
    reflinks; other filesystems fall back to full copy.
- **`packages/nexus-checkpoint/`** TS package exposing
  `CheckpointStore.create / restore / list / diff` via napi-rs.
- **Auto-checkpoint**: `bash` / `edit` / `write` tools create a checkpoint
  before mutating files.
- **`/rewind <id>` slash command** and **`nexus rewind <id>`** CLI: roll
  back the workspace to a prior checkpoint.
- Disk usage verified < 1.5× workspace size under typical workloads.

### Added — M4 (Grok multi-level compaction port)

- **`packages/nexus-compaction/`** TS package porting Grok Build's four
  compaction algorithms:
  - `interCompaction` — cross-turn summarization.
  - `intraCompaction` — within-turn duplicate removal.
  - `codeCompaction` — code-block compaction preserving signatures and
    comment placeholders.
  - `historyCompaction` — long-term history summarization.
- **Adapter** to omp's `packages/agent/src/compaction.ts` so the existing
  compaction contract is preserved.
- **`compaction.strategy`** config: `"omp"` (legacy) / `"nexus"` (Grok
  algorithms) / `"hybrid"` (default — `interCompaction` + `codeCompaction`).
- **SQuAD benchmark** in `packages/snapcompact` shows ≥ 20% token savings
  vs the omp baseline on the same eval set.

### Added — M5 (OpenClaude gRPC server port)

- **`packages/nexus-grpc/`** TS package with:
  - `proto/nexus.proto` — protocol definition, renamed from
    `openclaude.proto` (service `OpenClaude` → `Nexus`).
  - Server implementation using `@grpc/grpc-js` + `@grpc/proto-loader`.
  - **Adapter layer** to omp's `SessionManager` and `createAgentSession`.
- **RPCs exposed**: `Prompt` (unary), `StreamTokens` (server streaming),
  `SetModel`, `Abort`, `ToolPermission`, `ActionRequired` (server streaming).
- **CLI entry points**:
  - `nexus grpc --port 50051` — start the gRPC server.
  - `nexus grpc-cli` — built-in test client.
- **Client examples** for Python, Go, and Rust in
  `packages/nexus-grpc/examples/`.
- **End-to-end test** (`packages/nexus-grpc/test/e2e.test.ts`): a Python
  client issues a `Prompt`, asserts streaming token receipt.

### Added — M6 (OpenClaude VS Code extension port)

- **`vscode-extension/nexus-vscode/`** — forked from OpenClaude's extension
  and rebranded:
  - Publisher `nexus-agent`, displayName `Nexus Agent`.
  - Commands renamed: `openclaude.start` → `nexus.start` (+
    `nexus.startInWorkspaceRoot`, `nexus.openControlCenter`,
    `nexus.newChat`, `nexus.resumeSession`, `nexus.abortChat`).
  - Process manager spawns `nexus` instead of `openclaude`.
  - Theme renamed: `Nexus Terminal Black`.
- **Transport modes**: `stdio` (default — spawns `nexus` subprocess) and
  `grpc` (connects to `nexus grpc --port 50051`).
- **Permission modes**: `default` / `acceptEdits` (default) /
  `bypassPermissions` / `plan`.
- Verified end-to-end: `Nexus: Start` launches a session, renders streaming
  output, and surfaces permission prompts in the webview.

### Added — M7 (per-agent model routing)

- **`packages/nexus-routing/`** TS package:
  - `agentModels` — map of agent label → model ID.
  - `agentRouting` — declarative match rules with fallback model.
- **Bridges** omp's `ModelRegistry`: when a route matches, the corresponding
  `Provider` instance is constructed on demand.
- **`task` tool integration**: subagents dispatched via `task(label=...)`
  pick up their model from the routing config.
- **CLI**: `nexus config routing` launches an interactive configurator.
- **Routing priority** (highest to lowest): explicit (`--model` /
  `SetModel` RPC) > `routing` config > `global` `model` config.
- Unit tests cover the priority matrix in
  `packages/nexus-routing/test/routing.test.ts`.

### Added — M8 (Nexus brand unification + CLI entry)

- **Full rebrand** of all `omp` / `oh-my-pi` / `omp.sh` residuals across
  code, comments, docs, asset filenames. (Audit log in M8 task record.)
- **Assets**: new `assets/hero.png`, `assets/icon.svg`, `assets/banner.html`
  with the Nexus visual identity.
- **CLI**: help text, error messages, and TUI footer now reference Nexus.
- **Removed** the M1 auto-migration of `~/.omp/` (replaced by the manual
  `mv ~/.omp ~/.nexus` documented in
  [`docs/migration-guide.md`](./docs/migration-guide.md)).
- **Docs site** placeholder at `docs.nexus.agent`.

### Added — M9 (CI matrix + release pipeline)

- **CI matrix** (`.github/workflows/ci.yml`):
  - **`nexus_matrix`** — 34 combinations across `ubuntu-latest` /
    `macos-latest` / `windows-latest` × 9 representative providers
    (`anthropic` / `openai` / `deepseek` / `gemini` / `qwen` / `glm` /
    `kimi` / `ollama` / `mock`) × sandbox on/off. All matrix cells run in
    mock-provider mode (`NEXUS_TEST_MOCK=1`) — no live LLM API calls.
  - **`nexus_sandbox_sec`** — Linux-only Landlock integration tests,
    including `rm -rf /` rejection.
  - **`nexus_grpc_e2e`** — gRPC end-to-end test from a mock client.
  - **`nexus_checkpoint_test`** — `cargo test -p nexus-checkpoint` + bun
    tests on the TS package.
  - **`nexus_compaction_test`** — bun tests + a benchmark smoke run.
  - **`nexus_routing_test`** — bun tests covering routing priority.
  - **`nexus_coverage`** — Linux-only: aggregates `bun --coverage` +
    `cargo tarpaulin`, uploads `coverage/` as an artifact and to Codecov
    (when `CODECOV_TOKEN` is set).
  - **`nexus_security_audit`** — runs the new
    `bun scripts/security-audit.ts` in `hardening:strict` +
    `verify:privacy` mode.
- **`scripts/run-all-tests.ts`** — one-shot test runner covering cargo
    tests, bun tests, PTY e2e, gRPC e2e, and sandbox security.
- **`scripts/coverage.ts`** — aggregates TS + Rust coverage into
  `coverage/index.html` + `coverage/summary.json`.
- **`scripts/security-audit.ts`** — standalone security scanner with four
  modes: `hardening:strict`, `verify:privacy`, `audit:spawn`,
  `audit:network`. Exits non-zero on any `error` finding. Supports
  `--json` for CI consumption and `// nexus-audit-ignore: <reason>` for
  per-line exemptions.
- **`.github/workflows/release.yml`** — independent release pipeline
  triggered by `nexus-v*` tags (kept separate from omp's `v*` pipeline):
  - Multi-OS native addon build (Linux x64/arm64, macOS x64/arm64,
    Windows x64) via napi-rs.
  - VS Code extension vsix build.
  - `npm publish` for `@nexus-agent/*` packages.
  - `vsce publish` to the VS Code Marketplace (when `VSCE_PAT` is set).
  - GitHub Release with auto-generated changelog + native addon / vsix
    artifacts attached.
  - Manual `workflow_dispatch` with a `dry_run` input for validation.
- **`scripts/release.ts`** extended:
  - **`--dry-run` / `-n`**: pre-flight + version bump plan run, but no
    `git commit` / `git tag` / `git push` / lockfile regen / watch CI.
  - **`--nexus`**: uses `nexus-v*` tag prefix to trigger
    `.github/workflows/release.yml` (independent of omp's `v*`).
  - **VS Code manifest sync**: `vscode-extension/nexus-vscode/package.json`
    is now bumped alongside `package.json` and `Cargo.toml`.
  - **`@nexus-agent/*` catalog sync**: root `package.json` catalog
    entries for `@nexus-agent/*` are bumped in lockstep with
    `@oh-my-pi/*`.
  - Prerelease versions (`1.0.0-beta`) are now accepted by the version
    validator.

### Documentation

- **`docs/user-guide.md`** — installation, configuration, CLI reference,
  sandbox/rollback basics, FAQ.
- **`docs/integration-guide.md`** — gRPC clients (Python/Go/Rust), VS Code
  extension setup, per-agent routing, sandbox profile tuning, programmatic
  embedding of the `@nexus-agent/*` packages.
- **`docs/migration-guide.md`** — moving from omp to Nexus: `~/.omp/` →
  `~/.nexus/`, environment variable compatibility, CLI aliasing, rollback
  instructions, OpenClaude → Nexus migration path.
- **`README.md`** — Status bumped to v1.0.0-beta; M9 marked done;
  Documentation section now links to the three new guides and the
  changelog.

### Internal

- Root `package.json` version: `1.0.0-alpha` → `1.0.0-beta`.
- `Cargo.toml` `workspace.package.version`: `1.0.0-alpha` → `1.0.0-beta`.
- `vscode-extension/nexus-vscode/package.json` version: `0.2.0` →
  `1.0.0-beta` (now tracked by `scripts/release.ts`).
- New `package.json` scripts: `test:all` → `bun scripts/run-all-tests.ts`,
  `coverage` → `bun scripts/coverage.ts`.

## [1.0.0-alpha] - 2026-04

Initial public preview of Nexus Agent — the brand unification and CLI entry
point release covering M1 (fork omp + rebrand) through M8 (final rebrand).
All upstream capabilities from Grok Build and OpenClaude ported but not yet
covered by the release pipeline. See the M2–M8 entries above for what was
included.

[Unreleased]: https://github.com/nexus-agent/nexus-agent/compare/v1.0.0-beta...HEAD
[1.0.0-beta]: https://github.com/nexus-agent/nexus-agent/releases/tag/nexus-v1.0.0-beta
[1.0.0-alpha]: https://github.com/nexus-agent/nexus-agent/releases/tag/nexus-v1.0.0-alpha
