# Nexus Agent 迁移指南

> 从 omp（Oh My Pi）迁移到 Nexus Agent。

Nexus Agent 是 omp 的 fork，保留了 omp 的全部工具集与 CLI 体验，同时融合了 Grok Build（沙箱、checkpoint、compaction）和 OpenClaude（gRPC、VS Code 扩展、路由）的能力。本文档帮助 omp 用户平滑迁移到 Nexus。

---

## 目录

- [迁移概览](#迁移概览)
- [1. 配置目录迁移](#1-配置目录迁移)
- [2. 环境变量迁移](#2-环境变量迁移)
- [3. CLI 命令对照](#3-cli-命令对照)
- [4. 配置文件迁移](#4-配置文件迁移)
- [5. 工具与 slash 命令](#5-工具与-slash-命令)
- [6. 从 omp 的特定功能迁移](#6-从-omp-的特定功能迁移)
- [7. 回滚到 omp](#7-回滚到-omp)
- [8. FAQ](#faq)

---

## 迁移概览

| 维度 | omp | Nexus | 兼容性 |
|---|---|---|---|
| 配置目录 | `~/.omp/` | `~/.nexus/` | 完全兼容（mv 即可） |
| CLI 命令名 | `omp` | `nexus` | 别名兼容（OMP_PROFILE 仍生效） |
| 配置文件格式 | JSON | JSON | 完全兼容 |
| 工具集 | 60+ | 60+（同源） | 完全兼容 |
| 模型 provider | 50+ | 50+（同源） | 完全兼容 |
| 沙箱 | 无 | Landlock / Seatbelt / ISO FS | **新增** |
| Checkpoint | 无 | 基于 file hash 增量存储 | **新增** |
| Compaction | omp 原生 | omp / nexus / hybrid 三选一 | 兼容 + 增强 |
| gRPC server | 无 | `nexus grpc --port 50051` | **新增** |
| VS Code 扩展 | 无 | `Nexus: Start` | **新增** |
| per-agent 路由 | 无 | `nexus config routing` | **新增** |

**核心保证**：所有 omp 已有的命令、工具、配置项在 Nexus 中继续可用，无需修改现有工作流。

---

## 1. 配置目录迁移

### 自动迁移

Nexus v1.0.0-alpha 之前曾有自动迁移逻辑，但为了简化代码、避免静默行为，v1.0.0-beta 已移除自动迁移。请手动执行：

```sh
# 备份原目录（可选但推荐）
mv ~/.omp ~/.omp.backup

# 迁移到新目录
mv ~/.omp ~/.nexus
```

### 检查迁移结果

```sh
ls -la ~/.nexus/
# 应看到：
# - config.json
# - auth.json
# - settings.json
# - sessions/（历史会话）
# - mnemopi/（记忆数据库）
```

### 如果 ~/.nexus 已存在

如果之前装过 Nexus 测试版，需要合并：

```sh
# 把 ~/.omp 中独有的文件合并到 ~/.nexus
cp -rn ~/.omp/* ~/.nexus/
```

---

## 2. 环境变量迁移

Nexus 保留了 omp 的所有环境变量（向后兼容），同时引入了新的 `NEXUS_*` 前缀变量。

### 仍生效的 omp 环境变量

| 变量 | Nexus 中的行为 |
|---|---|
| `OMP_PROFILE` | 与 `NEXUS_PROFILE` 等价，仍生效 |
| `PI_PROFILE` | 同上，仍生效 |
| `OMP_API_KEY` | 仍生效（等价于 `ANTHROPIC_API_KEY`） |
| `PI_DATA_DIR` | 与 `NEXUS_DATA_DIR` 等价，仍生效 |

### 新增的 Nexus 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NEXUS_DATA_DIR` | `~/.nexus` | 数据目录 |
| `NEXUS_PROFILE` | `default` | 配置 profile 名称 |
| `NEXUS_SANDBOX_ENABLED` | `1` | 是否启用沙箱（`0` 禁用） |
| `NEXUS_SANDBOX_PROFILE` | `Workspace` | 沙箱策略 |
| `NEXUS_GRPC_PORT` | - | gRPC server 端口 |
| `NEXUS_TEST_MOCK` | - | 测试模式：使用 mock provider 不实际调 API |

### 推荐配置（迁移完成后）

把 `~/.bashrc` / `~/.zshrc` 中的 omp 变量改为 Nexus：

```sh
# 旧
# export OMP_PROFILE=work
# export PI_API_KEY=sk-...

# 新
export NEXUS_PROFILE=work
export ANTHROPIC_API_KEY=sk-...   # 用 provider 专用变量更清晰
```

旧变量继续生效，但新文档与脚本只引用 `NEXUS_*`。

---

## 3. CLI 命令对照

### 命令别名

如果你习惯用 `omp` 命令，可以加 alias：

```sh
# ~/.bashrc 或 ~/.zshrc
alias omp=nexus
```

### 命令对照表

| omp 命令 | Nexus 命令 | 说明 |
|---|---|---|
| `omp` | `nexus` | 启动 TUI |
| `omp -p "..."` | `nexus -p "..."` | 单次 prompt |
| `omp --model X` | `nexus --model X` | 指定模型 |
| `omp stats` | `nexus stats` | 显示统计 |
| - | `nexus grpc --port 50051` | **新增**：启动 gRPC server |
| - | `nexus grpc-cli` | **新增**：gRPC 客户端 |
| - | `nexus config routing` | **新增**：配置模型路由 |
| - | `nexus rewind <id>` | **新增**：回滚到 checkpoint |

### 参数对照

所有 `omp` 的命令行参数在 `nexus` 中继续可用，包括：

- `--model`、`-m` — 指定模型
- `--prompt`、`-p` — 单次 prompt
- `--smoke-test` — 内置冒烟测试
- `--version`、`-v` — 显示版本
- `--help`、`-h` — 显示帮助

---

## 4. 配置文件迁移

### config.json

Nexus 的 `config.json` 完全向后兼容 omp 的格式。原有字段无需修改。新增字段都有默认值，可不填。

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "approvalMode": "untrusted",

  // ── 以下是 Nexus 新增字段（可选） ──
  "sandbox": {
    "enabled": true,
    "profile": "Workspace",
    "violationPolicy": "deny"
  },
  "compaction": {
    "strategy": "hybrid",   // "omp" 完全等价于 omp 行为
    "threshold": 0.8
  },
  "routing": {
    "defaultModel": "claude-3-5-sonnet-20241022",
    "agentModels": {}
  }
}
```

### 保持 omp 行为

如果你想让 Nexus 完全等价于 omp（不启用新功能）：

```json
{
  "sandbox": { "enabled": false },
  "compaction": { "strategy": "omp" },
  "routing": {}
}
```

这样沙箱不启用、compaction 用 omp 算法、不做 per-agent 路由（所有子任务用全局模型）。

---

## 5. 工具与 slash 命令

### 工具集

Nexus 保留了 omp 的全部 60+ 工具，包括：
- `bash`、`read`、`write`、`edit`、`glob`、`grep`、`ast-edit`
- `web_search`、`fetch`、`browser`
- `task`（subagent 调度）
- `github`、`memory_edit`、`recall`、`reflect`、`learn`
- `eval`、`debug`、`lsp`、`tts` 等

工具行为完全相同，无需修改现有 prompt / 上下文文件。

### slash 命令

| omp slash | Nexus slash | 说明 |
|---|---|---|
| `/clear` | `/clear` | 清空上下文 |
| `/compact` | `/compact` | 触发压缩 |
| `/model X` | `/model X` | 切换模型 |
| - | `/rewind <id>` | **新增**：回滚 checkpoint |
| - | `/checkpoint` | **新增**：手动创建 checkpoint |
| `/help` | `/help` | 显示所有命令 |

---

## 6. 从 omp 的特定功能迁移

### Mnemopi 记忆系统

Mnemopi 记忆数据库位于 `~/.nexus/mnemopi/`，与 omp 的 `~/.omp/mnemopi/` 完全兼容。迁移后记忆库继续可用：

```sh
mv ~/.omp/mnemopi ~/.nexus/mnemopi
```

### Session 历史

历史会话文件位于 `~/.nexus/sessions/`，与 omp 兼容。可继续访问历史会话。

### collab-web

`bun run collab:web:dev` 命令继续可用，无变化。

### 自定义工具 / 扩展

omp 的扩展加载机制（`.omp/extensions/`）在 Nexus 中改为 `.nexus/extensions/`。迁移：

```sh
mv ~/.omp/extensions ~/.nexus/extensions
```

### Skills / Marketplaces

omp 的 skills 与 marketplaces 完全兼容：

```sh
mv ~/.omp/skills ~/.nexus/skills
mv ~/.omp/marketplaces ~/.nexus/marketplaces
```

详见 [skills.md](./skills.md) 与 [marketplace.md](./marketplace.md)。

---

## 7. 回滚到 omp

如果迁移后遇到问题，可回滚到 omp：

### 卸载 Nexus

```sh
# Bun 安装
bun remove -g @nexus-agent/coding-agent

# Homebrew
brew uninstall nexus

# 源码
cd ~/nexus-agent && bun run clean
```

### 恢复 omp 配置

```sh
mv ~/.nexus ~/.omp
```

### 重新安装 omp

按 omp 官方文档：https://github.com/can1357/oh-my-pi

### 反馈迁移问题

如果遇到迁移问题，请到 https://github.com/nexus-agent/nexus-agent/issues 提交 issue，附上：
- omp 版本号
- Nexus 版本号
- 迁移步骤
- 报错日志

---

## 8. FAQ

### Q: 迁移后，原来的 session 历史还能访问吗？

A: 能。session 历史格式未变，迁移后所有历史会话仍可访问、fork、resume。

### Q: 我自定义的 omp 配置（自定义 slash 命令、自定义工具）还能用吗？

A: 能。所有 `~/.omp/` 下的自定义内容（`commands/`、`extensions/`、`skills/`）在 `~/.nexus/` 下完全兼容。只需 `mv ~/.omp ~/.nexus` 即可。

### Q: omp 的 hashline 编辑协议还在吗？

A: 在。Nexus 完全保留了 omp 的 hashline 协议，所有 edit/write 操作的 hashline 兼容性不变。

### Q: 我的 API Key 还能用吗？

A: 能。所有 provider 的 API Key（Anthropic、OpenAI、DeepSeek 等）兼容性不变。环境变量 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等仍生效。

### Q: 我需要重新配置 sandbox 吗？

A: 不需要。sandbox 默认启用，profile 默认 `Workspace`，开箱即用。仅在需要自定义白名单时才需要改 `config.json`。

### Q: omp 的 LSP / DAP / Python REPL / RoboMP 等功能还在吗？

A: 在。所有 omp 的高级功能（LSP 集成、DAP 调试器、Python REPL、RoboMP 集成）在 Nexus 中完全保留，行为不变。

### Q: 升级 Nexus 后能再降级到 omp 吗？

A: 能，但降级后 Nexus 专有的功能（沙箱、checkpoint、gRPC、VS Code 扩展、路由）将不可用。建议在迁移前用 `git stash` 备份配置。

### Q: 从 OpenClaude 迁移到 Nexus 怎么做？

A: OpenClaude 用户迁移路径不同：
1. 安装 Nexus：`curl -fsSL https://nexus.agent/install | sh`
2. 把 OpenClaude 的配置手动迁移到 `~/.nexus/config.json`（字段名不同，需手动转换）
3. VS Code 扩展：卸载 OpenClaude 扩展，安装 Nexus 扩展
4. gRPC 客户端：把 `openclaude.proto` 改为 `nexus.proto`，重命名 service 即可（协议等价）

---

## 下一步

- [用户指南](./user-guide.md) — Nexus 基础使用
- [集成指南](./integration-guide.md) — gRPC、VS Code 扩展、路由、沙箱
- [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) — 上游致谢
