# Nexus Agent

<p align="center">
  <strong>An open-source AI coding agent — a fusion of three flagships.</strong>
  <br>
  <a href="https://github.com/wjb12387767/nexus-agent">github.com/wjb12387767/nexus-agent</a>
  <br><br>
  <em>English</em> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/wjb12387767/nexus-agent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/wjb12387767/nexus-agent?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://github.com/wjb12387767/nexus-agent/releases"><img src="https://img.shields.io/github/v/release/wjb12387767/nexus-agent?include_prereleases&style=flat&colorA=222222&colorB=58A6FF" alt="Release"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6&style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://ghcr.io/wjb12387767/nexus-agent"><img src="https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat&colorA=222222&logo=docker&logoColor=white" alt="Docker"></a>
</p>

<p align="center">
  <em>Fork of <a href="https://github.com/can1357/oh-my-pi">Oh My Pi (omp)</a> · absorbs capabilities from <a href="https://github.com/xai-org/grok-build">Grok Build</a> and <a href="https://github.com/Gitlawb/openclaude">OpenClaude</a></em>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Why Nexus](#why-nexus)
- [Architecture](#architecture)
- [Status](#status)
- [Install](#install)
  - [Option A: Docker (recommended)](#option-a-docker-recommended--no-toolchain-needed)
  - [Option B: Source build (macOS / Linux)](#option-b-source-build-macos--linux)
  - [Option C: Windows one-click launcher](#option-c-windows-one-click-launcher)
  - [Option D: Install script](#option-d-install-script-clones--builds-from-source)
  - [Migrating from omp](#migrating-from-omp-oh-my-pi)
- [Configuration](#configuration)
- [MCP Integrations (optional)](#mcp-integrations-optional)
- [Documentation](#documentation)
- [Engineering Manual (工业手册)](#engineering-manual-工业手册)
- [Known Limitations](#known-limitations)
- [Sponsor / 赞助](#sponsor--赞助)
- [License](#license)

## Overview

Nexus Agent is an open-source AI coding agent that fuses three flagship
open-source coding agents — **omp**, **Grok Build**, and **OpenClaude** — into
a single engineering base. The goal is not to build "yet another agent", but to
preserve each project's irreplaceable capability layer while eliminating their
individual gaps.

| Source | Role | Irreplaceable capability |
|---|---|---|
| **omp** | base | 60+ tools · Hashline edit protocol · 50+ providers · Mnemopi memory · LSP+DAP · multi-language eval · Collab |
| **Grok Build** | ported | OS-level sandbox (Landlock / Seatbelt) · Checkpoint rollback · Multi-level compaction |
| **OpenClaude** | ported | gRPC server · VS Code extension · per-agent model routing · Bash AST security walker |

The result is a single CLI entry point `nexus` that combines industrial-grade
security, service-oriented deployment, and broad model / tool coverage — all
under the MIT license.

## Why Nexus

Each of the three upstream projects solves a **different, non-overlapping**
class of problems:

- **omp** solves *breadth*: it has the richest tool layer and provider matrix,
  but no OS-level sandbox or session rollback.
- **Grok Build** solves *safety & reliability*: it has Landlock / Seatbelt
  isolation and checkpoint-based rollback, but a thin tool layer.
- **OpenClaude** solves *service & IDE integration*: it ships a gRPC server and
  a VS Code extension, but no sandbox or memory backend.

Nexus takes the position that these three concerns — breadth, safety,
service — are **orthogonal axes** of an industrial coding agent, and that
combining them on a single base is more valuable than any one in isolation. The
hardening layer on top closes the remaining known gaps in all three upstreams.

## Architecture

Nexus Agent uses a **TS + Rust NAPI hybrid architecture**, the dominant choice
for high-performance AI agents:

| Layer | Language | Role |
|---|---|---|
| Application | TypeScript 7.0 | Agent loop · tool orchestration · TUI · protocol adapters · business logic |
| Performance | Rust (stable) | File walk · grep/glob · AST parse · token counting · shell · PTY · sandbox · checkpoint |
| Binding | napi-rs 3.0 | Rust ↔ JS cross-language call (`.node` native module) |

Runtime: [Bun](https://bun.sh) ≥ 1.3.14 (chosen over Node.js for faster startup
and a built-in toolchain). Rust toolchain: stable ≥ 1.92.0 (**nightly is not
supported** — it causes NAPI compatibility issues).

### Hardening layer

On top of the three-way fusion, Nexus adds three capabilities that close known
gaps in every upstream agent:

| Capability | What it does | Where |
|---|---|---|
| **Bash AST security analysis** | tree-sitter-bash AST allowlist with `varScope` tracking and `declare -n` nameref detection, layered ahead of the legacy regex approver. Fail-closed: parse failure falls back to regex. | [`packages/nexus-bash-ast/`](./packages/nexus-bash-ast) · [`crates/pi-natives/src/bash_ast.rs`](./crates/pi-natives/src/bash_ast.rs) |
| **Doom loop detection** | Sliding-window detector that flags repeated identical `(tool, args)` calls across turns and nudges the model to change strategy. Orthogonal to `MAX_SOFT_TOOL_ESCALATIONS` and `noopLoopGuard`. | [`packages/agent/src/doom-loop-detector.ts`](./packages/agent/src/doom-loop-detector.ts) |
| **Destructive regression suite** | End-to-end tests covering sandbox-rejects-escape + checkpoint-restore, reflink CoW isolation, bash AST + sandbox dual defense, and compaction + checkpoint interaction. | [`packages/coding-agent/test/integration/destructive-regression.test.ts`](./packages/coding-agent/test/integration/destructive-regression.test.ts) |

## Status

**v1.0.0-beta** — all nine milestones (M0–M9) shipped, plus the hardening layer.
CI matrix + release pipeline online. Docker images published to GHCR on every
tag push. See [ROADMAP.md](./ROADMAP.md) for the milestone history and
[CHANGELOG.md](./CHANGELOG.md) for what landed in this release.

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

## Install

Nexus Agent ships in four forms. **Docker is the easiest** — no toolchain
install required. There is **no npm package or standalone binary** yet; the
agent runtime is TypeScript on Bun, not a single Rust executable.

| Option | When to use | Requirements |
|---|---|---|
| **A. Docker** | fastest, no toolchain | Docker ≥ 24.0 |
| **B. Source build** (macOS / Linux) | full control, contributing | Bun ≥ 1.3.14, Rust ≥ 1.92.0 stable |
| **C. Windows launcher** | Windows users, one-click | Windows 10+, PowerShell 5.1+ |
| **D. Install script** | automated / CI | same as B |

### Option A: Docker (recommended — no toolchain needed)

Prebuilt multi-arch images (`linux/amd64` + `linux/arm64`) are published to
GitHub Container Registry on every `nexus-v*` tag push.

```sh
# 1. Pull the beta image
docker pull ghcr.io/wjb12387767/nexus-agent:1.0.0-beta

# 2. Run the interactive TUI against the current directory
docker run --rm -it -v "$PWD":/work ghcr.io/wjb12387767/nexus-agent:1.0.0-beta cli

# 3. (optional) Start the full stack (agent + Qdrant + Docling + LightRAG)
docker compose up -d
docker compose exec nexus cli
```

**Full-stack mode** bundles all 4 MCP services via
[docker-compose.yml](./docker-compose.yml):

1. Copy [mcp.json.example](./mcp.json.example) to `~/.nexus/agent/mcp.json`
2. Fill in your API key (`LLM_API_KEY`, `LLM_API_BASE`, `LLM_MODEL`)
3. `docker compose up -d`

The compose file mounts `${WORKSPACE_DIR:-./workspace}` into `/work` and
persists `~/.nexus` (credentials, sessions, mnemopi DB) across rebuilds.

### Option B: Source build (macOS / Linux)

```sh
# 1. Clone
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent

# 2. Install Bun ≥ 1.3.14 (if not already installed)
curl -fsSL https://bun.sh/install | bash

# 3. Install Rust ≥ 1.92.0 stable (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable   # do NOT use nightly

# 4. Install workspace dependencies + build native addons
bun setup

# 5. Launch the TUI
bun dev
```

First run compiles Rust NAPI native modules — expect 10–20 minutes depending on
hardware. Subsequent runs are instant.

### Option C: Windows one-click launcher

A PowerShell launcher ([`start.ps1`](./start.ps1)) is included for Windows
users. It auto-detects and installs Bun / Rust, refreshes PATH, compiles native
modules on first run, then starts the dev server — no manual environment setup
required.

```powershell
# From the repo root, in PowerShell:
.\start.ps1              # auto-install toolchain + build + launch

# Useful flags:
.\start.ps1 -CheckOnly   # only verify Bun / Rust are available
.\start.ps1 -SkipBuild   # skip native module compilation (faster restart)
```

`start.bat` is a thin wrapper that prefers PowerShell 7 (`pwsh`) and falls back
to Windows PowerShell 5.1. Double-click `start.bat` in File Explorer for a
no-terminal launch.

> **Note:** `start.ps1` is encoded as UTF-8 with BOM for proper Chinese display
> on Windows. Do not re-save it as plain UTF-8 or the Chinese characters will
> garble in the legacy console host.

### Option D: Install script (clones + builds from source)

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.ps1 | iex
```

The script clones the repo, installs Bun + Rust if missing, runs `bun setup`,
and creates a `nexus` shim on your PATH. Use this for CI / automated deploys.

### Migrating from omp (Oh My Pi)

v1.0.0-alpha changed the config directory from `~/.omp/` to `~/.nexus/`. The
automatic migration logic from M1 has been removed. To upgrade:

```sh
mv ~/.omp ~/.nexus
```

The `OMP_PROFILE` / `PI_PROFILE` environment variables are still honored for
backward compatibility, but new documentation references `~/.nexus/`.

## Configuration

Nexus Agent reads configuration from three layers (later layers override
earlier ones):

1. **Defaults** — compiled into [`settings-schema.ts`](./packages/coding-agent/src/config/settings-schema.ts)
2. **User config** — `~/.nexus/agent/config.yml` (YAML, edit via `nexus config`)
3. **Project config** — `.nexus/` directory in the project root

Key defaults shipped in v1.0.0-beta (all **enabled** out of the box):

| Setting | What it does | Default |
|---|---|---|
| `astGrep.enabled` | AST structural code search | `true` |
| `bashInterceptor.enabled` | Intercept `cat`/`grep`/`find`/`sed`, route to dedicated tools | `true` |
| `sandbox.enabled` | OS-level bash isolation (Landlock / Seatbelt / ISO FS) | `true` |
| `checkpoint.enabled` | Session checkpoint / rewind | `true` |
| `checkpoint.autoEnabled` | Auto file-level checkpoint before `bash` / `edit` / `write` | `true` |
| `bash.astSecurity` | Bash AST allowlist layered ahead of regex approver | `true` |

### Repo map

[`crates/pi-ast/src/repomap.rs`](./crates/pi-ast/src/repomap.rs) and
[`crates/pi-natives/src/repomap.rs`](./crates/pi-natives/src/repomap.rs) expose
a Rust-powered repository outline generator (tree-sitter symbol extraction +
rank scoring) consumed by
[`packages/coding-agent/src/repo-map.ts`](./packages/coding-agent/src/repo-map.ts).
It produces a compact, ranked overview of the project structure so the agent
can ground its decisions in the actual file/symbol layout without reading
every file.

### Localization

The TUI ships with multilingual support. English is the default; Chinese
(zh-CN) translations are bundled in
[`packages/coding-agent/src/modes/i18n/`](./packages/coding-agent/src/modes/i18n)
covering settings, slash commands, options, and tab/group labels. Toggle the
display language via `nexus config` → **Language**.

## MCP Integrations (optional)

Nexus supports deep MCP (Model Context Protocol) integrations that extend the
agent with browser automation, document parsing, vector search, and knowledge
graph RAG. These are **optional** — each requires external services (Docker,
Python, uvx) and must be configured separately via `~/.nexus/agent/mcp.json`.
The agent works fully without them; add them only when you need the extra
capabilities.

| Integration | Source | Capability | Deep adaptation |
|---|---|---|---|
| **Playwright MCP** | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 20+ browser tools via accessibility snapshots (navigate, click, type, screenshot, tab management) | `config.ts` filter bypass — coexists with native Puppeteer browser tool |
| **Docling MCP** | [docling-project/docling-mcp](https://github.com/docling-project/docling-mcp) | PDF / Word / PPT / Excel / EPUB / images → structured Markdown, with OCR and table extraction | `markit.ts` transparent takeover — `read file.pdf` auto-routes to Docling Serve, falls back to mupdf-wasm |
| **Qdrant MCP** | [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | Production-grade vector database for long-term knowledge storage and similarity search | Docker container with persistent volume, auto-collection creation |
| **LightRAG MCP** | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | Knowledge graph RAG with entity extraction, 5 retrieval modes (naive / local / global / hybrid / mix) | Custom MCP bridge server with lazy init and embedding model auto-detection |

### Setup external services

```powershell
# Start Qdrant + Docling Serve (Windows)
powershell -ExecutionPolicy Bypass -File scripts/start-services.ps1
```

See [docs/mcp-config.md](./docs/mcp-config.md) for the full MCP configuration
reference, or use [mcp.json.example](./mcp.json.example) as a template.

## Documentation

### User-facing docs

- [用户指南](./docs/user-guide.md) — 安装、配置、CLI 命令、基本使用
- [集成指南](./docs/integration-guide.md) — gRPC 客户端、VS Code 扩展、per-agent 路由、沙箱配置
- [迁移指南](./docs/migration-guide.md) — 从 omp 迁移到 Nexus（含 `~/.omp/` → `~/.nexus/` 迁移）
- [MCP 配置参考](./docs/mcp-config.md) — 4 个 MCP server 的完整配置说明
- [设置参考](./docs/settings.md) — 所有配置项的完整说明

### Design & engineering docs

- [DESIGN.md](./DESIGN.md) — vision, architecture, capability mapping, license & naming
- [ROADMAP.md](./ROADMAP.md) — M1–M9 detailed steps, acceptance criteria, risks, dependencies
- [CHANGELOG.md](./CHANGELOG.md) — release notes for v1.0.0-beta and prior
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — upstream attributions (omp / Grok / OpenClaude)

## Engineering Manual (工业手册)

This repository ships with a **~80,000-word engineering manual** —
[docs/NEXUS-AGENT-GUIDE.md](./docs/NEXUS-AGENT-GUIDE.md) — titled
**"Nexus Agent 深度解析：面向工程师的开源 AI 编码智能体权威指南"**.

The manual is the result of a full-codebase deep read. It is **not** a rewrite
of the user docs — it answers a deeper question: *when an AI coding agent is
pushed to industrial grade, what does its interior actually look like, and what
engineering trade-offs lie behind each design decision?*

**Structure** (20 chapters + 2 appendices, ~2,229 lines):

| Part | Chapters | Coverage |
|---|---|---|
| **序言 + 第一 ~ 三章** | Project origin · tech stack · runtime internals | Why fuse three agents · TS+Rust+Bun · NAPI loader · module map |
| **第四 ~ 八章** | Tool system · provider federation · native modules | 60+ tools · Hashline edit · 50+ providers · Rust crates · NAPI binding contract |
| **第九 ~ 十二章** | Sandbox · checkpoint · compaction · memory | Landlock/Seatbelt · reflink CoW · 4-level compaction · mnemopi 3-backend split |
| **第十三 ~ 十六章** | TUI · i18n · repo map · MCP runtime | Ink renderer · zh-CN · tree-sitter repomap · stdio/SSE/HTTP transports |
| **第十七 ~ 十八章** | gRPC · VS Code extension | Bidirectional stream protocol · stdio + grpc transports · permission modes |
| **第十九 ~ 二十章** | Hardening layer · security model | Bash AST walker · doom loop · destructive regression · fail-closed principle |
| **附录 A / B** | Tool catalog · env vars | 60+ tool reference · all environment variables |

**Recommended reading order**:

- **First pass** (global picture): 序言 + Ch. 1, 2, 3, 19, 20
- **Second pass** (by interest): dive into any专题 chapter — chapters are
  relatively independent and can be read out of order.

The manual is written in Chinese (the primary engineering audience). English
translation is not planned; use machine translation if needed.

## Known Limitations

This is a **source-available beta**, not a production-ready release. Be aware
of the following limitations before using or contributing:

- **No npm distribution:** There is no published npm package. Install via Docker
  (recommended) or build from source (Bun + Rust toolchain).
- **No standalone binary:** The agent runtime is TypeScript on Bun, not a
  single Rust binary. The `release.yml` workflow builds `.node` NAPI addons
  per-platform but does not bundle Bun + TS into a single executable. Use
  Docker for a no-toolchain install.
- **CI depends on self-hosted runner:** The CI matrix uses a self-hosted runner
  (`omp-kata`) inherited from the upstream project. Forks without this runner
  will see CI failures on `main` branch pushes. PR-triggered CI uses
  `ubuntu-22.04` and works normally.
- **MCP integrations are optional:** Playwright, Docling, Qdrant, and LightRAG
  MCP servers require external services (Docker, Python, uvx). They are not
  bundled and must be configured separately. See
  [mcp.json.example](./mcp.json.example) for the configuration template.
- **Package scope:** Internal packages still use the `@oh-my-pi/*` npm scope
  inherited from the upstream project. Migration to `@nexus-agent/*` is planned
  but not yet executed. Do not attempt to `npm publish` these packages — you do
  not own the `@oh-my-pi` scope.
- **Domains are placeholders:** `nexus.agent`, `docs.nexus.agent`, and
  `collab.nexus.agent` are placeholder domains and do not resolve. All
  documentation is in-repo.
- **Build requirements:** Bun ≥ 1.3.14 + Rust ≥ 1.92.0 (stable). The build
  compiles Rust NAPI native modules, which takes 10–20 minutes on first run.

## Sponsor / 赞助

If Nexus Agent saves you time, a coffee helps keep the project alive.

如果 Nexus Agent 帮到了你,可以请作者喝杯咖啡。扫码即可:

![Sponsor QR Code](assets/sponsor-qr.jpg)

> 二维码内含微信 / 支付宝收款码。Sponsorship is voluntary and never required —
> the project stays MIT and open-source regardless.

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

Nexus Agent is an independent community project. It is not affiliated with,
endorsed by, or sponsored by SpaceXAI, Anthropic, or any upstream project.
"Claude" and "Claude Code" are trademarks of Anthropic PBC.
