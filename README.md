# Nexus Agent

<p align="center">
  <strong>Open-source AI coding agent — Terminal · Desktop · Web</strong>
  <br>
  <a href="https://github.com/wjb12387767/nexus-agent">github.com/wjb12387767/nexus-agent</a>
  <br><br>
  <em>English</em> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/wjb12387767/nexus-agent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/wjb12387767/nexus-agent?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://github.com/wjb12387767/nexus-agent/releases"><img src="https://img.shields.io/github/v/release/wjb12387767/nexus-agent?include_prereleases&style=flat&colorA=222222&colorB=58A6FF" alt="Release"></a>
  <a href="https://github.com/wjb12387767/nexus-agent/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/wjb12387767/nexus-agent/ci.yml?branch=main&style=flat&colorA=222222&colorB=58A6FF" alt="CI"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6&style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://ghcr.io/wjb12387767/nexus-agent"><img src="https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat&colorA=222222&logo=docker&logoColor=white" alt="Docker"></a>
</p>

<p align="center">
  <em>Forked from <a href="https://github.com/can1357/oh-my-pi">Oh My Pi (omp)</a> · absorbs capabilities from <a href="https://github.com/xai-org/grok-build">Grok Build</a>, <a href="https://github.com/Gitlawb/openclaude">OpenClaude</a> & hermes-agent</em>
</p>

---

## Overview

Nexus Agent is an open-source AI coding agent that fuses four flagship open-source coding agents — **omp**, **Grok Build**, **OpenClaude**, **hermes-agent** — onto a single engineering base. The goal is not "yet another agent" but to preserve each project's irreplaceable capability layer while eliminating their respective shortcomings.

| Source | Role | Irreplaceable capabilities |
|---|---|---|
| **omp** | Base | 60+ tools · Hashline edit protocol · 50+ providers · Mnemopi memory · LSP+DAP · Multi-language eval · Collab |
| **Grok Build** | Ported | OS-level sandbox (Landlock / Seatbelt) · Checkpoint rollback · Multi-level compaction |
| **OpenClaude** | Ported | gRPC server · VS Code extension · Per-agent model routing · Bash AST security walker |
| **hermes-agent** | Ported | Self-improvement loop (background review + curator + learn + learning graph) |

The result is a single CLI entry point `nexus`, released under MIT, combining industrial-grade security, service deployment, and broad model/tool coverage.

## Three Form Factors, One Kernel

Nexus Agent is available in three forms, all sharing the **same agent kernel** with identical capabilities:

| Form | Entry | Target user |
|---|---|---|
| **Terminal** | `nexus` CLI | Developers (full power, scriptable) |
| **Desktop** | WorkAny app (Tauri + React) | Non-technical users (GUI, same kernel via subprocess bridge) |
| **Web** | collab-web (browser) | Quick preview, collaborative sessions |

The desktop app does **not** reduce any capability — it spawns the `nexus` CLI as a subprocess and bridges JSON events to the UI. Every tool, sandbox, checkpoint, MCP, skill, and self-improvement feature is available in all three forms.

## Architecture

Nexus Agent uses a **TS + Rust NAPI hybrid architecture**:

| Layer | Language | Role |
|---|---|---|
| Application | TypeScript 7.0 | Agent loop · Tool orchestration · TUI · Protocol adaptation · Business logic |
| Performance | Rust (stable) | File traversal · grep/glob · AST parsing · Token counting · Shell · PTY · Sandbox · Checkpoint |
| Binding | napi-rs 3.0 | Rust ↔ JS cross-language calls (`.node` native modules) |

Runtime: [Bun](https://bun.sh) ≥ 1.3.14. Rust toolchain: stable ≥ 1.92.0 (**nightly not supported** — causes NAPI compatibility issues).

### Hardening Layer

Five capabilities added on top of the four-way fusion, closing known shortcomings of all upstream agents:

| Capability | Effect | Location |
|---|---|---|
| **Bash AST security** | tree-sitter-bash AST whitelist with `varScope` tracking and `declare -n` nameref detection, layered before regex approver. Fail-closed. | [`packages/nexus-bash-ast/`](./packages/nexus-bash-ast) · [`crates/pi-natives/src/bash_ast.rs`](./crates/pi-natives/src/bash_ast.rs) |
| **Doom loop detection** | Sliding-window detector for repeated `(tool, args)` calls across turns. | [`packages/agent/src/doom-loop-detector.ts`](./packages/agent/src/doom-loop-detector.ts) |
| **Destructive regression suite** | E2E tests: sandbox rejects out-of-bounds writes, checkpoint recovery, reflink CoW isolation. | [`packages/coding-agent/test/integration/destructive-regression.test.ts`](./packages/coding-agent/test/integration/destructive-regression.test.ts) |
| **Tool guardrails** | Failure-tracking guardrail layered on doom-loop detector: classifies exact/same-tool/no-progress patterns. | [`packages/agent/src/doom-loop-detector.ts`](./packages/agent/src/doom-loop-detector.ts) |
| **File safety** | Credential path protection (`.ssh` / `.aws` / `.gnupg` / `.kube` / `.docker` / `.azure` / `.env` / `.netrc` / `.pgpass` / `.git-credentials`) and `.env` read interception. | [`packages/coding-agent/src/tools/file-safety.ts`](./packages/coding-agent/src/tools/file-safety.ts) |

### Self-Improvement Layer

Fused from **hermes-agent**. Four capabilities form a **self-improvement loop**: `learn` (guided skill authoring) → `background review` (per-turn auto-evaluation) → `curator` (lifecycle management) → `learning graph` (visualization). All **opt-in** (off by default).

## Installation

### A. Docker (recommended, no toolchain)

```sh
docker pull ghcr.io/wjb12387767/nexus-agent:1.0.0-beta
docker run --rm -it -v "$PWD":/work ghcr.io/wjb12387767/nexus-agent:1.0.0-beta cli
```

Full-stack mode (agent + Qdrant + Docling + LightRAG via docker compose):

```sh
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent
cp .env.example .env   # fill in LLM credentials
docker compose up -d
docker compose exec nexus cli
```

### B. Source build (macOS / Linux)

**Prerequisites**: Bun ≥ 1.3.14, Rust ≥ 1.92.0 stable

```sh
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent
curl -fsSL https://bun.sh/install | bash          # if Bun not installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # if Rust not installed
rustup default stable   # do NOT use nightly
bun setup               # install deps + build native addons + link CLI
nexus                   # launch
```

First build compiles Rust NAPI modules (~10–20 min). Subsequent launches are instant.

### C. Windows launcher

```powershell
.\start.ps1              # auto-installs toolchain + builds + launches
.\start.ps1 -CheckOnly   # check Bun / Rust availability
.\start.ps1 -SkipBuild   # skip native module compilation
```

`start.ps1` is UTF-8 with BOM encoded for correct Chinese display on Windows. For full Linux capabilities (Landlock sandbox, reflink checkpoint, native bash) on Windows, use WSL2:

```bash
nexus wsl status    # detect WSL2 availability
nexus wsl launch    # launch agent inside WSL2
nexus wsl install   # print WSL install instructions
```

### D. Desktop app (WorkAny)

The desktop app is a Tauri + React application in [`workany-dev/`](./workany-dev/workany-dev/). It spawns the `nexus` CLI as a subprocess — **no capability reduction** versus the terminal.

**Current status**: pre-built installers (`.dmg` / `.msi` / `.exe` / `.deb` / `.rpm`) are not yet published to GitHub Releases. Build from source:

```sh
cd workany-dev/workany-dev
bun install
pnpm install

# Build for current platform (bundles nexus CLI + workany-api sidecar + Tauri app)
pnpm build:nexus

# Or target a specific platform:
pnpm build:nexus:mac-arm
pnpm build:nexus:linux
pnpm build:nexus:windows
```

Prerequisites: Bun, Rust stable, Node.js 20+, pnpm 9+. On Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libfuse2`.

### E. Web (collab-web)

The web client provides a browser-based view of nexus collab sessions — streaming transcript, tool-call cards, subagent panel, and a composer:

```sh
bun run collab:web:dev    # dev server at http://localhost:3000
```

See [`packages/collab-web/README.md`](./packages/collab-web/README.md) for details.

## Configuration

Nexus reads config from three layers (later overrides earlier):

1. **Defaults** — compiled into [`settings-schema.ts`](./packages/coding-agent/src/config/settings-schema.ts)
2. **User config** — `~/.nexus/agent/config.yml` (edit via `nexus config`)
3. **Project config** — `.nexus/` directory in project root

Key defaults (all **on** by default):

| Option | Effect | Default |
|---|---|---|
| `sandbox.enabled` | OS-level bash isolation (Landlock / Seatbelt / ISO FS) | `true` |
| `checkpoint.enabled` | Session checkpoint / rollback | `true` |
| `checkpoint.autoEnabled` | Auto file-level checkpoint before `bash` / `edit` / `write` | `true` |
| `bash.astSecurity` | Bash AST whitelist, layered before regex approver | `true` |
| `astGrep.enabled` | AST structured code search | `true` |
| `bashInterceptor.enabled` | Intercept `cat`/`grep`/`find`/`sed`, route to dedicated tools | `true` |

## MCP Integration (optional)

Nexus supports deep MCP (Model Context Protocol) integration. These are **optional** — each requires an external service (Docker, Python, uvx) and must be configured via `~/.nexus/agent/mcp.json`. The agent works fully without them.

| Integration | Capability | Source |
|---|---|---|
| **Playwright MCP** | 20+ browser tools via accessibility snapshot | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) |
| **Docling MCP** | PDF / Word / PPT / Excel / EPUB → Markdown with OCR | [docling-project/docling-mcp](https://github.com/docling-project/docling-mcp) |
| **Qdrant MCP** | Production vector database for long-term knowledge | [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) |
| **LightRAG MCP** | Knowledge graph RAG with 5 retrieval modes | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) |

Template: [`mcp.json.example`](./mcp.json.example). Full reference: [`docs/mcp-config.md`](./docs/mcp-config.md).

## Project Structure

```
nexus-agent/
├── packages/
│   ├── agent/              # Agent kernel (agent loop + event system)
│   ├── ai/                 # LLM provider abstraction (50+ providers)
│   ├── coding-agent/       # CLI + SDK + 60+ tools
│   ├── collab-web/         # Web client (browser sessions)
│   ├── nexus-grpc/         # gRPC server
│   ├── nexus-routing/      # Per-agent model routing
│   └── ...
├── crates/
│   ├── nexus-sandbox/      # OS sandbox (Landlock / Seatbelt)
│   ├── nexus-checkpoint/   # File checkpoint (reflink CoW)
│   ├── pi-natives/         # Rust native modules (grep, glob, AST, PTY...)
│   └── ...
├── workany-dev/            # Desktop app (Tauri + React)
│   └── workany-dev/
│       ├── src/            # Frontend (React + TailwindCSS)
│       ├── src-api/        # Backend API (Hono + Bun, sidecar)
│       └── src-tauri/      # Tauri shell (Rust)
├── vscode-extension/       # VS Code extension
└── docs/                   # Documentation (80k-word engineering manual + user guides)
```

## Documentation

### User docs

- [User Guide](./docs/user-guide.md) — installation, configuration, CLI reference, basics
- [Integration Guide](./docs/integration-guide.md) — gRPC clients, VS Code extension, per-agent routing, sandbox tuning
- [Migration Guide](./docs/migration-guide.md) — omp → Nexus (`~/.omp/` → `~/.nexus/`)
- [MCP Config](./docs/mcp-config.md) — complete MCP server configuration
- [Settings Reference](./docs/settings.md) — all config options

### Engineering docs

- [**Engineering Manual**](./docs/NEXUS-AGENT-GUIDE.md) — ~80,000-word deep dive (24 chapters + 4 appendices)
- [DESIGN.md](./DESIGN.md) — vision, architecture, capability mapping
- [ROADMAP.md](./ROADMAP.md) — M1–M9 milestones, acceptance criteria
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — upstream attribution

## Known Limitations

This is a **source-available beta**, not a production release:

- **No npm distribution**: Install via Docker (recommended) or source build (Bun + Rust).
- **No standalone binary**: The runtime is TypeScript on Bun, not a single Rust executable.
- **Docker image is amd64 only**: arm64 cross-compilation exceeds GitHub runner disk limits.
- **Desktop installers not yet published**: Build WorkAny from source (see [Desktop app](#d-desktop-app-workany)).
- **Windows sandbox limitations**: Uses ISO FS (no kernel-level deny). Use WSL2 or Docker for full sandbox.
- **MCP integrations are optional**: Require external services (Docker / Python / uvx).
- **Package scope**: Internal packages still use `@oh-my-pi/*` scope (migration to `@nexus-agent/*` planned).

## Development

```sh
bun install              # install root dependencies

bun run dev              # terminal dev mode
bun run collab:web:dev   # web client dev mode (http://localhost:3000)

cd workany-dev/workany-dev
bun install
pnpm install
pnpm dev:all             # desktop dev mode (API + Tauri app)
```

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

Nexus Agent is an independent community project, not affiliated with, endorsed by, or sponsored by SpaceXAI, Anthropic, or any upstream project. "Claude" and "Claude Code" are trademarks of Anthropic PBC.
