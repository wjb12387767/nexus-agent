# Nexus Agent 用户指南

> 面向最终用户：安装、配置、基本使用、CLI 命令参考。

Nexus Agent 是一个开源的 AI 编码 Agent，融合了 omp（工具层）、Grok Build（沙箱与回滚）、OpenClaude（gRPC 与 VS Code 扩展）三大旗舰项目的能力。本文档面向使用 Nexus 完成日常编码任务的开发者。

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [CLI 命令参考](#cli-命令参考)
- [沙箱与回滚](#沙箱与回滚)
- [模型路由](#模型路由)
- [常见问题](#常见问题)

---

## 安装

### 一键安装（推荐）

**macOS / Linux：**

```sh
curl -fsSL https://nexus.agent/install | sh
```

**Windows（PowerShell）：**

```powershell
irm https://nexus.agent/install.ps1 | iex
```

### 通过 Bun 安装

```sh
bun install -g @nexus-agent/coding-agent
```

### 从源码构建

```sh
git clone https://github.com/nexus-agent/nexus-agent.git
cd nexus-agent
bun setup      # 安装 workspace 依赖 + 构建 native addon
bun dev        # 启动 TUI
```

**前置要求：**
- Bun ≥ 1.3.14
- Rust（通过 rustup 安装，nightly-2026-04-29 工具链）
- Git ≥ 2.30

---

## 快速开始

### 启动 TUI

```sh
nexus                 # 在当前目录启动交互式 TUI
nexus --model claude-3-5-sonnet-20241022   # 指定模型
```

TUI 启动后会读取当前目录作为工作区。所有 Agent 操作（读写文件、运行命令）默认限制在该工作区内。

### 单次命令模式

```sh
nexus -p "把这段代码重构成 async/await 风格"  # 单次 prompt，不进 TUI
```

### 配置 API Key

在首次运行时，Nexus 会引导你配置 API Key。也可手动设置环境变量：

```sh
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...
```

完整 provider 列表见 [providers.md](./providers.md)。

---

## 配置

Nexus 的配置文件位于 `~/.nexus/`：

```
~/.nexus/
├── config.json         # 主配置
├── auth.json           # API Key（不提交到 git）
├── settings.json       # 用户偏好（TUI 主题、键位等）
└── sandbox/           # 沙箱工作区根目录
```

### config.json 示例

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "sandbox": {
    "enabled": true,
    "profile": "Workspace",
    "violationPolicy": "deny"
  },
  "compaction": {
    "strategy": "nexus",
    "threshold": 0.8
  },
  "routing": {
    "defaultModel": "claude-3-5-sonnet-20241022",
    "agentModels": {
      "code-reviewer": "deepseek/deepseek-coder"
    }
  }
}
```

### 关键配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `model` | string | - | 默认模型 ID |
| `sandbox.enabled` | boolean | `true` | 是否启用沙箱（Linux/macOS 用 Landlock/Seatbelt，Windows 降级为 ISO FS） |
| `sandbox.profile` | `"Workspace"` \| `"Custom"` | `"Workspace"` | 沙箱策略：Workspace 限定工作区，Custom 允许自定义白名单 |
| `sandbox.violationPolicy` | `"deny"` \| `"warn"` | `"deny"` | 沙箱违规时的行为：拒绝或仅警告 |
| `compaction.strategy` | `"omp"` \| `"nexus"` \| `"hybrid"` | `"nexus"` | 上下文压缩算法 |
| `compaction.threshold` | number | `0.8` | 触发压缩的上下文占用比例 |
| `routing.defaultModel` | string | - | 全局默认模型 |
| `routing.agentModels` | object | `{}` | 按 agent 名称指定模型 |

详细配置参考：[settings.md](./settings.md)、[config-usage.md](./config-usage.md)。

---

## CLI 命令参考

### 全局选项

```
nexus [options] [command]

Options:
  -v, --version          显示版本号
  -h, --help             显示帮助
  -m, --model <id>       指定模型（覆盖 config.json）
  -p, --prompt <text>    单次 prompt，不进 TUI
  --smoke-test           内置冒烟测试
```

### 子命令

#### `nexus`（默认：启动 TUI）

```sh
nexus                                    # 启动交互式 TUI
nexus --model claude-3-5-sonnet-20241022  # 指定模型
```

#### `nexus config routing`

交互式配置 per-agent 模型路由：

```sh
nexus config routing
```

详见 [集成指南 - 模型路由](./integration-guide.md#模型路由)。

#### `nexus grpc --port 50051`

启动 gRPC server，让外部客户端（Python/Go/Rust）通过 gRPC 调用 Agent：

```sh
nexus grpc --port 50051
```

详见 [集成指南 - gRPC 服务](./integration-guide.md#grpc-服务)。

#### `nexus grpc-cli`

gRPC 命令行客户端，用于测试 gRPC server：

```sh
nexus grpc-cli --port 50051 --prompt "解释这段代码"
```

#### `nexus stats`

显示当前会话的 token 使用统计：

```sh
nexus stats
```

#### `nexus rewind <id>`

回滚到指定 checkpoint：

```sh
nexus rewind abc123          # 回滚到 checkpoint abc123
nexus rewind --list          # 列出所有 checkpoint
```

详见 [沙箱与回滚](#沙箱与回滚)。

### Slash 命令（TUI 内）

进入 TUI 后可使用以下 slash 命令：

- `/rewind <id>` — 回滚到指定 checkpoint
- `/checkpoint` — 手动创建 checkpoint
- `/clear` — 清空当前会话上下文
- `/compact` — 手动触发上下文压缩
- `/model <id>` — 切换当前会话的模型
- `/help` — 显示所有 slash 命令

---

## 沙箱与回滚

### 沙箱

Nexus 在 Linux 上使用 [Landlock](https://docs.kernel.org/userspace-api/landlock.html)，在 macOS 上使用 [Seatbelt](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) 实现 OS 级文件系统隔离。在 Windows 上降级为 ISO FS（Projected FS）。

沙箱阻止 Agent 访问工作区之外的文件系统，包括：
- 工作区外的写操作（如 `rm -rf /`、写入 `/etc/passwd`）
- 访问 `~/.ssh/`、`~/.aws/` 等敏感目录
- 通过 `bash` 工具执行的任意子进程也会被沙箱限制

如需允许特定路径（如读取宿主的 `.gitconfig`），在 `config.json` 中加白名单：

```json
{
  "sandbox": {
    "profile": "Custom",
    "customPaths": ["~/.gitconfig", "/tmp/nexus-shared"]
  }
}
```

### Checkpoint 回滚

每次 Agent 调用 `bash` / `edit` / `write` 工具前，Nexus 会自动创建一个 checkpoint。Checkpoint 基于：
- 文件 hash 增量存储（只保存修改过的块）
- LRU + 大小限制（默认 1 GB）
- ISO FS reflink 优化（btrfs / APFS 优先用 reflink，无 copy）

```sh
nexus rewind --list                  # 列出最近 20 个 checkpoint
nexus rewind abc123                  # 回滚到 abc123
```

回滚会恢复所有在 checkpoint 创建后被修改的文件。磁盘占用通常 < 工作区大小的 1.5 倍。

---

## 模型路由

Nexus 支持 per-agent 模型路由：不同的子任务（subagent）可以使用不同的模型。例如代码审查用 DeepSeek，文档生成用 Claude，搜索用 GPT-4o-mini。

详见 [集成指南 - 模型路由](./integration-guide.md#模型路由)。

---

## 常见问题

### Q: 启动时报 "Landlock not supported" 错误？

A: Linux 内核版本需 ≥ 5.13。在容器内运行时，宿主内核也需支持 Landlock。可在 `config.json` 中设 `"sandbox.enabled": false` 临时绕过（不推荐生产环境）。

### Q: Windows 上沙箱为什么是 ISO FS？

A: Windows 没有 Landlock 等价的内核接口。Nexus 在 Windows 上使用 Projected FS（ISO FS）实现降级隔离。功能上：能限制写、但无法像 Landlock 那样限制网络和敏感目录访问。建议生产环境用 Linux/macOS。

### Q: 如何禁用沙箱？

A: 不推荐。如确需禁用（如运行需要 root 权限的命令），在 `config.json`：

```json
{ "sandbox": { "enabled": false } }
```

或环境变量：`NEXUS_SANDBOX_DISABLED=1`。

### Q: 回滚会丢失哪些数据？

A: 回滚只恢复工作区文件。git 提交历史、外部副作用（如发送的网络请求、运行过的数据库迁移）不会回滚。

### Q: 如何升级到新版本？

A:

```sh
# Bun 安装的用户
bun upgrade @nexus-agent/coding-agent

# Homebrew 安装的用户
brew upgrade nexus

# 源码构建的用户
git pull && bun setup
```

升级后配置文件保持兼容，无需手动迁移。

---

## 下一步

- [集成指南](./integration-guide.md) — 通过 gRPC、VS Code 扩展、模型路由把 Nexus 接入你的工作流
- [迁移指南](./migration-guide.md) — 从 omp 迁移到 Nexus
- [DESIGN.md](../DESIGN.md) — 设计哲学与架构
