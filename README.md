# Nexus Agent

<p align="center">
  <strong>The strongest open-source AI coding agent — a fusion of three flagships.</strong>
  <br>
  <a href="https://nexus.agent">nexus.agent</a>
</p>

<p align="center">
  <a href="https://github.com/nexus-agent/nexus-agent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nexus-agent/nexus-agent?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  <em>Fork of <a href="https://github.com/can1357/oh-my-pi">Oh My Pi (omp)</a> · absorbs capabilities from <a href="https://github.com/xai-org/grok-build">Grok Build</a> and <a href="https://github.com/Gitlawb/openclaude">OpenClaude</a></em>
</p>

---

## Why Nexus

The three strongest open-source coding agents each own one irreplaceable
capability layer that the others lack. Nexus fuses them on a single engineering
base.

| Source | Irreplaceable capability |
|---|---|
| **omp** (base) | 60+ tools · Hashline edit protocol · 50+ providers · Mnemopi memory · LSP+DAP · multi-language eval · Collab |
| **Grok Build** (ported) | OS-level sandbox (Landlock/Seatbelt) · Checkpoint rollback · Multi-level compaction |
| **OpenClaude** (ported) | gRPC server · VS Code extension · per-agent model routing · **Bash AST security walker** |

## Hardening layer

On top of the three-way fusion, Nexus adds a hardening layer that closes known
gaps in the upstream agents:

| Capability | What it does | Where |
|---|---|---|
| **Bash AST security analysis** | tree-sitter-bash AST allowlist with `varScope` tracking and `declare -n` nameref detection, layered ahead of the legacy regex approver. Fail-closed: parse failure falls back to regex. | [`packages/nexus-bash-ast/`](./packages/nexus-bash-ast) · [`crates/pi-natives/src/bash_ast.rs`](./crates/pi-natives/src/bash_ast.rs) |
| **Doom loop detection** | Sliding-window detector that flags repeated identical `(tool, args)` calls across turns and nudges the model to change strategy. Orthogonal to `MAX_SOFT_TOOL_ESCALATIONS` and `noopLoopGuard`. | [`packages/agent/src/doom-loop-detector.ts`](./packages/agent/src/doom-loop-detector.ts) |
| **Destructive regression suite** | End-to-end tests covering sandbox-rejects-escape + checkpoint-restore, reflink CoW isolation, bash AST + sandbox dual defense, and compaction + checkpoint interaction. | [`packages/coding-agent/test/integration/destructive-regression.test.ts`](./packages/coding-agent/test/integration/destructive-regression.test.ts) |

## Status

**v1.0.0-beta** — all nine milestones shipped, plus the hardening layer.
CI matrix + release pipeline online. See [ROADMAP.md](./ROADMAP.md) for the
milestone history, and [CHANGELOG.md](./CHANGELOG.md) for what landed in this
release.

| Milestone | Goal | Status |
|---|---|---|
| M0 | Project skeleton + design docs | ✅ done |
| M1 | Fork omp as base, rebrand to Nexus | ✅ done |
| M2 | Port Grok OS sandbox to NAPI | ✅ done |
| M3 | Port Grok checkpoint/rollback | ✅ done |
| M4 | Absorb Grok multi-level compaction | ✅ done |
| M5 | Port OpenClaude gRPC server | ✅ done |
| M6 | Port OpenClaude VS Code extension | ✅ done |
| M7 | Implement per-agent model routing | ✅ done |
| M8 | Final rebrand + v1.0.0-alpha | ✅ done |
| M9 | CI matrix + release pipeline → v1.0.0-beta | ✅ done |
| Hardening | Bash AST + doom loop + destructive regression | ✅ done |

## Documentation

- [用户指南](./docs/user-guide.md) — 安装、配置、CLI 命令、基本使用
- [集成指南](./docs/integration-guide.md) — gRPC 客户端、VS Code 扩展、per-agent 路由、沙箱配置
- [迁移指南](./docs/migration-guide.md) — 从 omp 迁移到 Nexus（含 `~/.omp/` → `~/.nexus/` 迁移）
- [DESIGN.md](./DESIGN.md) — vision, architecture, capability mapping, license & naming
- [ROADMAP.md](./ROADMAP.md) — M1–M9 detailed steps, acceptance criteria, risks, dependencies
- [CHANGELOG.md](./CHANGELOG.md) — release notes for v1.0.0-beta and prior
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — upstream attributions (omp / Grok / OpenClaude)

## Install

```sh
# macOS / Linux
curl -fsSL https://nexus.agent/install | sh

# Windows (PowerShell)
irm https://nexus.agent/install.ps1 | iex

# Bun
bun install -g @nexus-agent/coding-agent
```

### Migrating from omp (Oh My Pi)

v1.0.0-alpha changes the config directory from `~/.omp/` to `~/.nexus/`.
The automatic migration logic from M1 has been removed. To upgrade:

```sh
mv ~/.omp ~/.nexus
```

The `OMP_PROFILE` / `PI_PROFILE` environment variables are still honored for
backward compatibility, but new documentation references `~/.nexus/`.

## Build from source

```sh
bun setup      # install workspaces + build native addon
bun dev        # launch the TUI
```

Requirements: Bun ≥ 1.3.14, Rust (rustup-managed toolchain).

## Sponsor / 赞助

If Nexus Agent saves you time, a coffee helps keep the project alive.

如果 Nexus Agent 帮到了你,可以请作者喝杯咖啡。扫码即可:

<p align="center">
  <img src="./assets/sponsor-qr.jpg" alt="Sponsor QR Code" width="360">
</p>

> 二维码内含微信 / 支付宝收款码。Sponsorship is voluntary and never required —
> the project stays MIT and open-source regardless.

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

Nexus Agent is an independent community project. It is not affiliated with,
endorsed by, or sponsored by SpaceXAI, Anthropic, or any upstream project.
"Claude" and "Claude Code" are trademarks of Anthropic PBC.
