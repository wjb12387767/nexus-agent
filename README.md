# Nexus Agent

> 自我进化的 AI 编码智能体 — Web 端、桌面端、终端三端统一

## 产品概述

Nexus Agent 是一个开源的 AI 编码智能体，提供三种使用方式：
- **终端**：`nexus` CLI（开发者首选）
- **桌面端**：Nexus WorkAny 桌面应用（非技术用户首选）
- **Web 端**：浏览器访问（快速体验）

三端共享同一个智能体内核，功能完全对齐。

## 核心能力

- **Agent 内核**：Agent loop + 工具调用 + 流式输出 + 上下文压缩
- **安全沙箱**：Landlock/Seatbelt 进程隔离 + Bash AST 安全分析
- **检查点回滚**：Reflink 快照 + 一键回退
- **自我改进**：学习图谱 + 自动反思 + 错误归纳
- **多 Provider**：Anthropic/OpenAI/DeepSeek/Qwen/Ollama 等
- **MCP 协议**：标准 MCP 客户端 + 服务端
- **Skills 系统**：可扩展的技能模块
- **Checkpoint/Rewind**：文件状态快照与回滚

## 快速开始

### 终端安装（源码构建）

**前置依赖**：Bun 1.3.14+、Rust 1.92.0+（稳定通道）

```sh
# 1. 克隆仓库
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent

# 2. 安装依赖并构建原生模块
bun install
bun setup   # 构建 Rust 原生模块 + link CLI

# 3. 启动
nexus

# Windows 用户可使用一键脚本（UTF-8 with BOM）
./start.ps1
```

> Bun 与 Rust 安装参考 [Bun 官网](https://bun.sh) 与 [Rust 官网](https://rustup.rs)。

### 桌面端安装

从 GitHub Releases 下载对应平台的安装包：
- macOS: `.dmg`
- Windows: `.msi` 或 `.exe`
- Linux: `.deb` / `.rpm` / `.AppImage`

安装后打开应用，配置 LLM API Key 即可使用。

### Web 端

```sh
# 本地启动 Web 服务
nexus grpc --port 8080

# 浏览器访问 http://localhost:8080
```

## 三端功能对齐

| 功能 | 终端 | 桌面端 | Web 端 |
|---|---|---|---|
| Agent 对话 | ✅ | ✅ | ✅ |
| 工具调用 | ✅ | ✅ | ✅ |
| 沙箱隔离 | ✅ | ✅ | ✅ |
| 检查点回滚 | ✅ | ✅ | ✅ |
| 自我改进 | ✅ | ✅ | ✅ |
| MCP 工具 | ✅ | ✅ | ✅ |
| Skills | ✅ | ✅ | ✅ |
| 文件操作 | ✅ | ✅ | ✅ |
| 工作空间选择 | ✅ | ✅ | ✅ |
| 设置面板 | ✅ | ✅ | ✅ |
| 热力图分析 | ❌ | ✅ | ✅ |
| 消息撤回 | ❌ | ✅ | ✅ |
| GUI 动画 | ❌ | ✅ | ✅ |

## 桌面端构建

```sh
# 一键构建（当前平台）
pnpm build:nexus

# 全平台交叉编译
pnpm build:nexus:all

# 指定平台
pnpm build:nexus:mac-arm
pnpm build:nexus:linux
pnpm build:nexus:windows
```

## 项目结构

```
nexus-agent/
├── packages/
│   ├── agent/           # Agent 内核（Agent loop + 事件系统）
│   ├── ai/              # LLM Provider 抽象
│   ├── coding-agent/    # CLI + SDK + 工具系统
│   └── collab-web/      # Web 协作端
├── crates/
│   ├── nexus-sandbox/   # 沙箱（Landlock/Seatbelt）
│   ├── nexus-checkpoint/ # 检查点（Reflink）
│   └── pi-natives/      # 原生模块
├── workany-dev/         # 桌面端（Tauri + React）
│   ├── src/             # 前端
│   ├── src-api/         # 后端 API
│   └── src-tauri/       # Tauri 壳
├── vscode-extension/    # VS Code 扩展
└── docs/                # 文档
```

## 配置

nexus-agent 使用 `~/.nexus/` 作为配置目录：
- `settings.json` — 全局设置
- `commands/` — 自定义命令
- `sessions/` — 会话历史

桌面端使用 `~/.workany/` 作为数据目录。

## 开发

```sh
# 安装依赖
bun install

# 启动终端开发模式
bun run dev

# 启动桌面端开发模式
cd workany-dev/workany-dev
bun install
bun run dev:all
```

## License

MIT
