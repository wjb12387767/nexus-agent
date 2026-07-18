# Nexus Agent — 设计文档

> **一句话定位**：以 Oh My Pi (omp) 为基座，融合 Grok Build 的 OS 级安全/可靠性能力，与 OpenClaude 的服务化/IDE 集成能力，得到的最强开源 AI 编码智能体。

## 1. 项目愿景

Nexus Agent 是一个开源 AI 编码智能体，目标是把目前分散在三个顶级项目中的"不可替代能力"汇聚到一个工程化基座上：

| 来源 | 贡献能力 |
|---|---|
| **omp** (基座) | 工具广度（60+ 工具）、Hashline 编辑协议、50+ Provider、Mnemopi 记忆、LSP+DAP、多语言 eval、Collab 协作 |
| **Grok Build** (移植) | OS 级沙箱（Landlock/Seatbelt）、Checkpoint 回滚、多级 compaction、Computer Hub |
| **OpenClaude** (移植) | gRPC server、VS Code 扩展、per-agent 模型路由（agentModels + agentRouting） |

**最终产物特征：**
- 单一 CLI 入口 `nexus`
- TS + Rust NAPI 混合架构（继承 omp）
- 工业级安全（Grok 沙箱）+ 服务化（OpenClaude gRPC）+ 全模型广度（omp 50+ Provider）

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Bun ≥ 1.3.14 |
| 主语言 | TypeScript 7.0 |
| 性能层 | Rust + napi-rs 3.0 |
| 构建 | Bun workspaces + Cargo workspace |
| Lint | Biome (TS) + Clippy (Rust) |
| 测试 | Bun test + per-cargo tests + PTY e2e |
| 协议 | ACP / MCP / Hashline / gRPC |

## 3. 顶层架构

```
nexus-agent/
├── packages/                # TS monorepo（继承 omp 16 包 + 新增）
│   ├── coding-agent/        # ← omp fork 主入口
│   ├── agent/               # ← omp agent runtime
│   ├── ai/                  # ← omp 50+ Provider
│   ├── hashline/            # ← omp 编辑协议
│   ├── mnemopi/             # ← omp 记忆系统
│   ├── natives/             # ← omp NAPI 绑定
│   ├── nexus-sandbox/       # 🆕 M2 Grok 沙箱 TS 绑定
│   ├── nexus-checkpoint/    # 🆕 M3 Grok Checkpoint TS 层
│   ├── nexus-compaction/    # 🆕 M4 Grok 多级 compaction 算法
│   ├── nexus-grpc/          # 🆕 M5 OpenClaude gRPC server
│   └── nexus-routing/       # 🆕 M7 per-agent 模型路由
├── crates/                  # Rust workspace
│   ├── pi-natives/          # ← omp NAPI addon
│   ├── pi-shell/            # ← omp embedded shell
│   ├── pi-ast/              # ← omp AST
│   ├── pi-iso/              # ← omp ISO FS
│   ├── nexus-sandbox/       # 🆕 M2 Landlock/Seatbelt
│   ├── nexus-checkpoint/    # 🆕 M3 checkpoint store
│   └── nexus-compaction/    # 🆕 M4 compaction core
├── vscode-extension/        # 🆕 M6 VS Code 扩展
├── docs/                    # 设计 + 路线 + 用户指南
├── package.json             # Bun workspace 根
├── Cargo.toml               # Cargo workspace 根
└── DESIGN.md / ROADMAP.md
```

## 4. 能力来源映射

| Nexus 能力 | 来源 | 落地方式 |
|---|---|---|
| 60+ 工具 | omp | 直接 fork |
| Hashline 编辑 | omp | 直接 fork |
| 50+ Provider | omp | 直接 fork |
| LSP / DAP / Eval | omp | 直接 fork |
| OS 沙箱 | Grok `xai-grok-sandbox` | Rust crate 移植 + NAPI 绑定 |
| Checkpoint 回滚 | Grok `xai-grok-workspace/session` | 算法移植到 TS + Rust 后端 |
| 多级 compaction | Grok `xai-grok-compaction` | 算法 TS 重写，复用 omp compaction 接口 |
| gRPC server | OpenClaude `src/proto` | proto + 实现作为独立包 |
| VS Code 扩展 | OpenClaude `vscode-extension/` | 重命名 + CLI 适配 |
| per-agent 路由 | OpenClaude `agentModels/agentRouting` | 配置层 + omp ModelRegistry 桥接 |

## 5. License 与归属

- **Nexus Agent 主协议**：MIT
- **omp 贡献**：保留 © 2025 Mario Zechner / © 2025-2026 Can Bölük 版权声明
- **Grok Build 贡献**：移植代码保留 Apache-2.0 声明 + §4(b) 修改通知
- **OpenClaude 贡献**：MIT 声明保留 + Anthropic 商标免责
- **THIRD-PARTY-NOTICES.md**：列出所有移植来源与修改点

## 6. 命名规范

- **CLI 命令**：`nexus`
- **npm scope**：`@nexus-agent/*`
- **Rust crate 前缀**：`nexus-*`
- **配置目录**：`~/.nexus/`
- **环境变量前缀**：`NEXUS_*`
- **会话/快照目录**：`~/.nexus/sessions/`、`~/.nexus/checkpoints/`

## 7. 与上游的关系

- **omp**：保持可 cherry-pick 的提交历史，定期同步上游
- **Grok Build**：作为只读镜像，按需 cherry-pick 特定 crate
- **OpenClaude**：作为只读镜像，按需 cherry-pick gRPC/VSCode
- **不向 Grok Build 上游 PR**（其明确不接受外部贡献）

## 8. 不做的事（YAGNI）

- 不重写 omp 已有的工具实现
- 不引入 Grok 的 leader cluster 多进程架构（过重）
- 不引入 Grok 的 telemetry/Mixpanel（隐私优先）
- 不引入 OpenClaude 的 brands/models/vendors 三层抽象（omp 已有 catalog）
- 不做 Android/iOS 客户端
