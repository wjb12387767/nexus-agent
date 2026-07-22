# Nexus Agent

<p align="center">
  <strong>An open-source AI coding agent — a fusion of three flagships.</strong>
  <br>
  <a href="https://github.com/wjb12387767/nexus-agent">github.com/wjb12387767/nexus-agent</a>
</p>

<p align="center">
  <a href="https://github.com/wjb12387767/nexus-agent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/wjb12387767/nexus-agent?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
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

## MCP Integrations (Optional)

Nexus supports deep MCP (Model Context Protocol) integrations that extend the
agent with browser automation, document parsing, vector search, and knowledge
graph RAG. These are **optional** — each requires external services (Docker,
Python, uvx) and must be configured separately via `~/.nexus/agent/mcp.json`.
The agent works fully without them; add them only when you need the extra
capabilities.

| Integration | Source | Capability | Deep adaptation |
|---|---|---|---|
| **Playwright MCP** | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 20+ browser tools via accessibility snapshots (navigate, click, type, screenshot, tab management) | `config.ts` filter bypass — coexists with native Puppeteer browser tool |
| **Docling MCP** | [docling-project/docling-mcp](https://github.com/docling-project/docling-mcp) | PDF/Word/PPT/Excel/EPUB/images → structured Markdown, with OCR and table extraction | `markit.ts` transparent takeover — `read file.pdf` auto-routes to Docling Serve, falls back to mupdf-wasm |
| **Qdrant MCP** | [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | Production-grade vector database for long-term knowledge storage and similarity search | Docker container with persistent volume, auto-collection creation |
| **LightRAG MCP** | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | Knowledge graph RAG with entity extraction, 5 retrieval modes (naive/local/global/hybrid/mix) | Custom MCP bridge server with lazy init and embedding model auto-detection |

### Setup external services

```powershell
# Start Qdrant + Docling Serve (Windows)
powershell -ExecutionPolicy Bypass -File scripts/start-services.ps1
```

See [docs/mcp-config.md](./docs/mcp-config.md) for the full MCP configuration reference.

## Install

> **Note:** Nexus Agent is currently source-only. There is no npm package or
> prebuilt binary release yet. You need Bun ≥ 1.3.14 and Rust ≥ 1.92.0 (stable).

### Option 1: Install script (clones from GitHub, builds from source)

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.ps1 | iex
```

### Option 2: Manual build from source

```sh
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent
bun setup      # install workspaces + build native addon
bun dev        # launch the TUI
```

Requirements: Bun ≥ 1.3.14, Rust ≥ 1.92.0 (stable toolchain via rustup;
**do not use nightly** — it causes native module compatibility issues).

### Migrating from omp (Oh My Pi)

v1.0.0-alpha changes the config directory from `~/.omp/` to `~/.nexus/`.
The automatic migration logic from M1 has been removed. To upgrade:

```sh
mv ~/.omp ~/.nexus
```

The `OMP_PROFILE` / `PI_PROFILE` environment variables are still honored for
backward compatibility, but new documentation references `~/.nexus/`.

## Build from source

See **Option 2** under [Install](#install) above.

### Windows one-click launcher

A PowerShell launcher is included for Windows users. It auto-detects and
installs Bun / Rust, compiles native modules on first run, then starts the dev
server — no manual environment setup required.

```powershell
.\start.ps1            # auto-install toolchain + build + launch
.\start.ps1 -CheckOnly # only verify Bun / Rust are available
.\start.ps1 -SkipBuild # skip native module compilation
```

`start.bat` is a thin wrapper that prefers PowerShell 7 (`pwsh`) and falls back
to Windows PowerShell 5.1.

## Localization

The TUI ships with multilingual support. English is the default; Chinese
(zh-CN) translations are bundled in
[`packages/coding-agent/src/modes/i18n/`](./packages/coding-agent/src/modes/i18n)
covering settings, slash commands, options, and tab/group labels. Toggle the
display language via `nexus config` → **Language**.

## Repo map

`crates/pi-ast/src/repomap.rs` and `crates/pi-natives/src/repomap.rs` expose a
Rust-powered repository outline generator (tree-sitter symbol extraction +
rank scoring) consumed by
[`packages/coding-agent/src/repo-map.ts`](./packages/coding-agent/src/repo-map.ts).
It produces a compact, ranked overview of the project structure so the agent
can ground its decisions in the actual file/symbol layout without reading
every file.

## Known Limitations

This is a **source-available beta**, not a production-ready release. Be aware
of the following limitations before using or contributing:

- **No npm distribution:** There is no published npm package. Install requires
  building from source (Bun + Rust toolchain).
- **No prebuilt binaries:** The release workflow exists but GitHub Release
  binaries are not yet available. The `nexus-v*` tag pattern is defined in
  `release.yml` but no release has been published.
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
