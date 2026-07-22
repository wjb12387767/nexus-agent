# Nexus Agent

<p align="center">
  <strong>开源 AI 编码智能体 —— 三大旗舰融合</strong>
  <br>
  <a href="https://github.com/wjb12387767/nexus-agent">github.com/wjb12387767/nexus-agent</a>
  <br><br>
  <a href="./README.md">English</a> · <em>简体中文</em>
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
  <em>Fork 自 <a href="https://github.com/can1357/oh-my-pi">Oh My Pi (omp)</a> · 吸收 <a href="https://github.com/xai-org/grok-build">Grok Build</a> 与 <a href="https://github.com/Gitlawb/openclaude">OpenClaude</a> 的能力</em>
</p>

---

## 目录

- [项目概述](#项目概述)
- [为什么要做 Nexus](#为什么要做-nexus)
- [架构](#架构)
- [状态](#状态)
- [安装](#安装)
  - [方式 A:Docker(推荐)](#方式-adocker推荐无需工具链)
  - [方式 B:源码构建(macOS / Linux)](#方式-b源码构建macos--linux)
  - [方式 C:Windows 一键启动器](#方式-cwindows-一键启动器)
  - [方式 D:安装脚本](#方式-d安装脚本克隆并从源码构建)
  - [从 omp 迁移](#从-ompoh-my-pi-迁移)
- [配置](#配置)
- [MCP 集成(可选)](#mcp-集成可选)
- [文档](#文档)
- [工程手册](#工程手册)
- [已知限制](#已知限制)
- [赞助](#赞助)
- [许可证](#许可证)

## 项目概述

Nexus Agent 是一个开源 AI 编码智能体,把三个旗舰开源编码智能体 —— **omp**、**Grok Build**、**OpenClaude** —— 融合到同一个工程化基座上。目标不是"再造一个 agent",而是保留每个项目不可替代的能力层,同时消除它们各自的短板。

| 来源 | 角色 | 不可替代能力 |
|---|---|---|
| **omp** | 基座 | 60+ 工具 · Hashline 编辑协议 · 50+ Provider · Mnemopi 记忆 · LSP+DAP · 多语言 eval · Collab 协作 |
| **Grok Build** | 移植 | OS 级沙箱(Landlock / Seatbelt)· Checkpoint 回滚 · 多级 compaction |
| **OpenClaude** | 移植 | gRPC server · VS Code 扩展 · per-agent 模型路由 · Bash AST 安全 walker |

最终产物是一个单一 CLI 入口 `nexus`,在 MIT 协议下整合工业级安全、服务化部署、广泛的模型与工具覆盖。

## 为什么要做 Nexus

三个上游项目各自解决了一类**互不重叠**的问题:

- **omp** 解决*广度*:它有最丰富的工具层和 Provider 矩阵,但没有 OS 级沙箱或会话回滚。
- **Grok Build** 解决*安全与可靠性*:它有 Landlock / Seatbelt 隔离和基于 checkpoint 的回滚,但工具层单薄。
- **OpenClaude** 解决*服务化与 IDE 集成*:它有 gRPC server 和 VS Code 扩展,但没有沙箱或记忆后端。

Nexus 的立场是:广度、安全、服务化是工业级编码智能体的**三个正交轴**,把它们融合到同一基座上比任何单独一个都更有价值。顶部的加固层则关闭了三个上游共有的剩余短板。

## 架构

Nexus Agent 采用 **TS + Rust NAPI 混合架构**,这是高性能 AI Agent 的主流选择:

| 层 | 语言 | 角色 |
|---|---|---|
| 应用层 | TypeScript 7.0 | Agent 循环 · 工具编排 · TUI · 协议适配 · 业务逻辑 |
| 性能层 | Rust(stable) | 文件遍历 · grep/glob · AST 解析 · token 计数 · shell · PTY · 沙箱 · checkpoint |
| 绑定层 | napi-rs 3.0 | Rust ↔ JS 跨语言调用(`.node` 原生模块) |

运行时:[Bun](https://bun.sh) ≥ 1.3.14(选择 Bun 而非 Node.js 是因为启动更快且内置工具链)。Rust 工具链:stable ≥ 1.92.0(**不支持 nightly** —— 会导致 NAPI 兼容性问题)。

### 加固层

在三方融合之上,Nexus 新增了三个能力,关闭了所有上游 agent 的已知短板:

| 能力 | 作用 | 位置 |
|---|---|---|
| **Bash AST 安全分析** | tree-sitter-bash AST 白名单,带 `varScope` 跟踪和 `declare -n` nameref 检测,叠在传统 regex approver 之前。失败即关闭:解析失败回退到 regex。 | [`packages/nexus-bash-ast/`](./packages/nexus-bash-ast) · [`crates/pi-natives/src/bash_ast.rs`](./crates/pi-natives/src/bash_ast.rs) |
| **Doom loop 检测** | 滑动窗口检测器,标记跨 turn 重复的相同 `(tool, args)` 调用,nudge 模型改变策略。与 `MAX_SOFT_TOOL_ESCALATIONS` 和 `noopLoopGuard` 正交。 | [`packages/agent/src/doom-loop-detector.ts`](./packages/agent/src/doom-loop-detector.ts) |
| **破坏性回归测试套件** | 端到端测试:沙箱拒绝越界写 + checkpoint 恢复、reflink CoW 隔离、bash AST + 沙箱双重防御、compaction + checkpoint 交互。 | [`packages/coding-agent/test/integration/destructive-regression.test.ts`](./packages/coding-agent/test/integration/destructive-regression.test.ts) |

## 状态

**v1.0.0-beta** —— 九个里程碑(M0–M9)全部交付,加固层也已就位。CI 矩阵 + 发布流水线在线,Docker 镜像在每次 tag push 时发布到 GHCR。详见 [ROADMAP.md](./ROADMAP.md) 和 [CHANGELOG.md](./CHANGELOG.md)。

| 里程碑 | 目标 | 状态 |
|---|---|---|
| M0 | 项目骨架 + 设计文档 | ✅ 完成 |
| M1 | Fork omp 作为基座,rebrand 为 Nexus | ✅ 完成 |
| M2 | 移植 Grok OS 沙箱到 NAPI | ✅ 完成 |
| M3 | 移植 Grok checkpoint/回滚 | ✅ 完成 |
| M4 | 吸收 Grok 多级 compaction | ✅ 完成 |
| M5 | 移植 OpenClaude gRPC server | ✅ 完成 |
| M6 | 移植 OpenClaude VS Code 扩展 | ✅ 完成 |
| M7 | 实现 per-agent 模型路由 | ✅ 完成 |
| M8 | 最终 rebrand + v1.0.0-alpha | ✅ 完成 |
| M9 | CI 矩阵 + 发布流水线 → v1.0.0-beta | ✅ 完成 |
| 加固层 | Bash AST + doom loop + 破坏性回归 | ✅ 完成 |

## 安装

Nexus Agent 提供 4 种安装方式。**Docker 最简单** —— 无需安装工具链。目前**没有 npm 包或独立二进制**;agent 运行时是 TypeScript on Bun,不是单个 Rust 可执行文件。

| 方式 | 适用场景 | 要求 |
|---|---|---|
| **A. Docker** | 最快,无需工具链 | Docker ≥ 24.0 |
| **B. 源码构建**(macOS / Linux) | 完全控制,参与贡献 | Bun ≥ 1.3.14,Rust ≥ 1.92.0 stable |
| **C. Windows 启动器** | Windows 用户,一键启动 | Windows 10+,PowerShell 5.1+ |
| **D. 安装脚本** | 自动化 / CI | 同 B |

### 方式 A:Docker(推荐,无需工具链)

预构建的 `linux/amd64` 镜像在每次 `nexus-v*` tag push 时发布到 GitHub Container Registry。(暂不支持 arm64 —— 跨架构编译 Rust NAPI 模块时撑爆了 GitHub runner 的磁盘;详见[已知限制](#已知限制)。)

**快速启动(单容器):**

```sh
docker pull ghcr.io/wjb12387767/nexus-agent:1.0.0-beta
docker run --rm -it -v "$PWD":/work ghcr.io/wjb12387767/nexus-agent:1.0.0-beta cli
```

**完整栈模式(agent + Qdrant + Docling + LightRAG,通过 docker compose):**

```sh
# 1. 克隆仓库
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent

# 2. 复制环境模板并填入 LLM 凭证
cp .env.example .env
#   编辑 .env:
#     LLM_API_BASE=http://host.docker.internal:18317/v1   # 你的 LLM 端点
#     LLM_API_KEY=sk-your-api-key-here                    # 你的 API key
#     LLM_MODEL=grok-4.5                                  # 你的模型名

# 3. (可选)把 WORKSPACE_DIR 指向你想让 agent 工作的项目
#    默认是 ./workspace(仓库内的沙箱目录)。

# 4. 启动完整栈
docker compose up -d

# 5. 进入 agent 的交互式 TUI
docker compose exec nexus cli
```

compose 文件([docker-compose.yml](./docker-compose.yml))编排的服务:

| 服务 | 用途 |
|---|---|
| `nexus` | agent 运行时(TUI + 工具层)。把 `WORKSPACE_DIR` 挂载到 `/work`,`~/.nexus` 持久化到命名卷。 |
| `qdrant` | 向量数据库,长期知识存储。端口 6333(REST)/ 6334(gRPC)。 |
| `docling` | PDF/Word/PPT/Excel/EPUB → Markdown。首次运行下载约 1–2 GB 模型。 |
| `lightrag` | 知识图谱 RAG,5 种检索模式。运行 [externals/lightrag-mcp-bridge/](./externals/lightrag-mcp-bridge/) 里的 bridge 脚本。 |
| `playwright` | (注释掉的 —— 可选)浏览器自动化。在 compose 里取消注释即可启用。 |

4 个 MCP 服务都通过服务名(如 `http://qdrant:6333`)在 `nexus-net` Docker 网络内寻址 —— 无需配置 host 端口。

### 方式 B:源码构建(macOS / Linux)

```sh
# 1. 克隆
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent

# 2. 安装 Bun ≥ 1.3.14(如果尚未安装)
curl -fsSL https://bun.sh/install | bash

# 3. 安装 Rust ≥ 1.92.0 stable(如果尚未安装)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable   # 不要用 nightly

# 4. 安装 workspace 依赖 + 构建原生 addon
bun setup

# 5. 启动 TUI
bun dev
```

首次运行会编译 Rust NAPI 原生模块 —— 预计 10–20 分钟,视硬件而定。后续启动是秒级的。

### 方式 C:Windows 一键启动器

为 Windows 用户提供了 PowerShell 启动器([`start.ps1`](./start.ps1))。它会自动检测并安装 Bun / Rust,刷新 PATH,首次运行时编译原生模块,然后启动 dev server —— 无需手动配置环境。

```powershell
# 在仓库根目录,用 PowerShell 执行:
.\start.ps1              # 自动安装工具链 + 构建 + 启动

# 常用参数:
.\start.ps1 -CheckOnly   # 仅检查 Bun / Rust 是否可用
.\start.ps1 -SkipBuild   # 跳过原生模块编译(快速重启)
```

`start.bat` 是一个薄包装,优先使用 PowerShell 7(`pwsh`),回退到 Windows PowerShell 5.1。在文件资源管理器双击 `start.bat` 可无终端启动。

> **注意:** `start.ps1` 以 UTF-8 with BOM 编码保存,以保证 Windows 上中文正常显示。不要把它重新存为纯 UTF-8,否则旧版控制台主机里中文字符会乱码。

### 方式 D:安装脚本(克隆并从源码构建)

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.ps1 | iex
```

脚本会克隆仓库、安装缺失的 Bun + Rust、运行 `bun setup`,并在你的 PATH 上创建 `nexus` shim。适合 CI / 自动化部署。

### 从 omp(Oh My Pi)迁移

v1.0.0-alpha 把配置目录从 `~/.omp/` 改为 `~/.nexus/`。M1 的自动迁移逻辑已移除。升级方式:

```sh
mv ~/.omp ~/.nexus
```

`OMP_PROFILE` / `PI_PROFILE` 环境变量仍向后兼容,但新文档统一引用 `~/.nexus/`。

## 配置

Nexus Agent 从三层读取配置(后者覆盖前者):

1. **默认值** —— 编译进 [`settings-schema.ts`](./packages/coding-agent/src/config/settings-schema.ts)
2. **用户配置** —— `~/.nexus/agent/config.yml`(YAML,通过 `nexus config` 编辑)
3. **项目配置** —— 项目根目录的 `.nexus/` 目录

v1.0.0-beta 出厂默认值(全部**默认开启**):

| 配置项 | 作用 | 默认值 |
|---|---|---|
| `astGrep.enabled` | AST 结构化代码搜索 | `true` |
| `bashInterceptor.enabled` | 拦截 `cat`/`grep`/`find`/`sed`,路由到专用工具 | `true` |
| `sandbox.enabled` | OS 级 bash 隔离(Landlock / Seatbelt / ISO FS) | `true` |
| `checkpoint.enabled` | 会话 checkpoint / 回滚 | `true` |
| `checkpoint.autoEnabled` | 在 `bash` / `edit` / `write` 前自动文件级 checkpoint | `true` |
| `bash.astSecurity` | Bash AST 白名单,叠在 regex approver 之前 | `true` |

### Repo map

[`crates/pi-ast/src/repomap.rs`](./crates/pi-ast/src/repomap.rs) 和
[`crates/pi-natives/src/repomap.rs`](./crates/pi-natives/src/repomap.rs) 暴露了一个
Rust 驱动的仓库大纲生成器(tree-sitter 符号提取 + rank 评分),被
[`packages/coding-agent/src/repo-map.ts`](./packages/coding-agent/src/repo-map.ts) 消费。
它生成紧凑、按重要性排序的项目结构概览,让 agent 可以基于实际文件/符号布局做决策,而不必读每个文件。

### 本地化

TUI 自带多语言支持。默认英文;中文(zh-CN)翻译打包在
[`packages/coding-agent/src/modes/i18n/`](./packages/coding-agent/src/modes/i18n),
覆盖设置、slash 命令、选项、tab/group 标签。通过 `nexus config` → **Language** 切换显示语言。

## MCP 集成(可选)

Nexus 支持深度 MCP(Model Context Protocol)集成,扩展 agent 的浏览器自动化、文档解析、向量搜索、知识图谱 RAG 能力。这些是**可选的** —— 每个都需要外部服务(Docker、Python、uvx),必须通过 `~/.nexus/agent/mcp.json` 单独配置。agent 不装这些也能完整工作;只在需要额外能力时才加。

| 集成 | 来源 | 能力 | 深度适配 |
|---|---|---|---|
| **Playwright MCP** | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 通过 accessibility snapshot 提供 20+ 浏览器工具(导航、点击、输入、截图、tab 管理) | `config.ts` 过滤旁路 —— 与原生 Puppeteer 浏览器工具共存 |
| **Docling MCP** | [docling-project/docling-mcp](https://github.com/docling-project/docling-mcp) | PDF / Word / PPT / Excel / EPUB / 图片 → 结构化 Markdown,带 OCR 和表格提取 | `markit.ts` 透明接管 —— `read file.pdf` 自动路由到 Docling Serve,失败回退 mupdf-wasm |
| **Qdrant MCP** | [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | 生产级向量数据库,用于长期知识存储和相似度搜索 | Docker 容器 + 持久卷,自动创建 collection |
| **LightRAG MCP** | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 知识图谱 RAG,带实体抽取、5 种检索模式(naive / local / global / hybrid / mix) | 自定义 MCP bridge server,懒加载 + embedding 模型自动检测 |

### 启动外部服务

```powershell
# 启动 Qdrant + Docling Serve(Windows)
powershell -ExecutionPolicy Bypass -File scripts/start-services.ps1
```

完整 MCP 配置参考见 [docs/mcp-config.md](./docs/mcp-config.md),或直接用 [mcp.json.example](./mcp.json.example) 作为模板。

## 文档

### 用户文档

- [用户指南](./docs/user-guide.md) —— 安装、配置、CLI 命令、基本使用
- [集成指南](./docs/integration-guide.md) —— gRPC 客户端、VS Code 扩展、per-agent 路由、沙箱配置
- [迁移指南](./docs/migration-guide.md) —— 从 omp 迁移到 Nexus(含 `~/.omp/` → `~/.nexus/` 迁移)
- [MCP 配置参考](./docs/mcp-config.md) —— 4 个 MCP server 的完整配置说明
- [设置参考](./docs/settings.md) —— 所有配置项的完整说明

### 设计与工程文档

- [DESIGN.md](./DESIGN.md) —— 愿景、架构、能力映射、license & 命名
- [ROADMAP.md](./ROADMAP.md) —— M1–M9 详细步骤、验收标准、风险、依赖
- [CHANGELOG.md](./CHANGELOG.md) —— v1.0.0-beta 及之前的发布说明
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) —— 上游归属(omp / Grok / OpenClaude)

## 工程手册

本仓库附带一份 **约 8 万字的工程手册** ——
[docs/NEXUS-AGENT-GUIDE.md](./docs/NEXUS-AGENT-GUIDE.md),标题为
**《Nexus Agent 深度解析:面向工程师的开源 AI 编码智能体权威指南》**。

这份手册是对全部核心代码逐文件深度阅读的产物。它**不是**用户文档的改写 —— 它回答的是一个更深层的问题:*当一个 AI 编码智能体被推向工业级时,它的内部到底长什么样?每一个设计决策背后的工程权衡是什么?*

**结构**(20 章 + 2 附录,约 2,229 行):

| 部分 | 章节 | 覆盖 |
|---|---|---|
| **序言 + 第一 ~ 三章** | 项目溯源 · 技术栈 · 运行时内部 | 为什么融合三个 agent · TS+Rust+Bun · NAPI loader · 模块地图 |
| **第四 ~ 八章** | 工具系统 · Provider 联邦 · 原生模块 | 60+ 工具 · Hashline 编辑 · 50+ Provider · Rust crate · NAPI binding 契约 |
| **第九 ~ 十二章** | 沙箱 · checkpoint · compaction · 记忆 | Landlock/Seatbelt · reflink CoW · 4 级 compaction · mnemopi 3 后端分工 |
| **第十三 ~ 十六章** | TUI · i18n · repo map · MCP runtime | Ink 渲染器 · zh-CN · tree-sitter repomap · stdio/SSE/HTTP 传输 |
| **第十七 ~ 十八章** | gRPC · VS Code 扩展 | 双向流协议 · stdio + grpc 传输 · 权限模式 |
| **第十九 ~ 二十章** | 加固层 · 安全模型 | Bash AST walker · doom loop · 破坏性回归 · fail-closed 原则 |
| **附录 A / B** | 工具目录 · 环境变量 | 60+ 工具参考 · 全部环境变量 |

**推荐阅读顺序**:

- **第一遍**(建立全局观):序言 + 第 1、2、3、19、20 章
- **第二遍**(按兴趣深入):任意专题章节 —— 各章相对独立,可跳跃阅读。

## 已知限制

这是一个 **source-available beta**,不是生产级 release。使用或贡献前请注意以下限制:

- **无 npm 分发:** 没有发布 npm 包。通过 Docker(推荐)或从源码构建(Bun + Rust 工具链)安装。
- **无独立二进制:** agent 运行时是 TypeScript on Bun,不是单个 Rust 二进制。`release.yml` 流水线会按平台构建 `.node` NAPI addon,但不会把 Bun + TS 打包成单个可执行文件。无工具链安装请用 Docker。
- **Docker 镜像仅支持 amd64:** GHCR 镜像只构建 `linux/amd64`。arm64 跨架构编译超过了 GitHub runner 14 GB 磁盘上限(Rust NAPI 编译 + node_modules 安装需要约 20 GB)。在 Apple Silicon 或其他 arm64 主机上,用 Docker 的 amd64 模拟(`--platform linux/amd64`)或从源码构建。
- **CI 依赖 self-hosted runner:** CI 矩阵使用从上游继承的 self-hosted runner(`omp-kata`)。没有这个 runner 的 fork 在 `main` 分支 push 时会看到 CI 失败。PR 触发的 CI 用 `ubuntu-22.04`,正常工作。
- **MCP 集成是可选的:** Playwright、Docling、Qdrant、LightRAG MCP server 需要外部服务(Docker、Python、uvx)。它们不打包,必须单独配置。配置模板见 [mcp.json.example](./mcp.json.example)。
- **包 scope:** 内部包仍使用从上游继承的 `@oh-my-pi/*` npm scope。迁移到 `@nexus-agent/*` 已规划但尚未执行。不要尝试 `npm publish` 这些包 —— 你不拥有 `@oh-my-pi` scope。
- **域名是占位符:** `nexus.agent`、`docs.nexus.agent`、`collab.nexus.agent` 是占位域名,不可解析。所有文档都在仓库内。
- **构建要求:** Bun ≥ 1.3.14 + Rust ≥ 1.92.0(stable)。构建会编译 Rust NAPI 原生模块,首次约 10–20 分钟。

## 赞助

如果 Nexus Agent 帮到了你,可以请作者喝杯咖啡。扫码即可:

![Sponsor QR Code](assets/sponsor-qr.jpg)

> 二维码内含微信 / 支付宝收款码。赞助纯属自愿,永不强制 —— 无论是否赞助,项目始终是 MIT 开源。

## 许可证

MIT。详见 [LICENSE](./LICENSE) 和 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

Nexus Agent 是独立的社区项目,与 SpaceXAI、Anthropic 或任何上游项目均无隶属、背书或赞助关系。"Claude" 和 "Claude Code" 是 Anthropic PBC 的商标。
