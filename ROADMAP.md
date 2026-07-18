# Nexus Agent — 路线图

> 9 个里程碑，按依赖顺序排列。每个里程碑独立可验收。

## M1 — 以 omp 为基座初始化代码库

**目标**：把 omp 仓库 fork 为 nexus-agent，完成重命名与版权声明，保证 `bun dev` 可启动。

**输入**：`oh-my-pi-main/` 源码（约 200K LOC）

**步骤**：
1. 整体拷贝 `oh-my-pi-main/` 到 `nexus-agent/`（覆盖已存在的 docs/packages/crates）
2. 顶层 `package.json`：name 改为 `nexus-agent`，bin 改为 `nexus`，scope 改为 `@nexus-agent/*`
3. 全局替换品牌字符串：`omp` → `nexus`、`oh-my-pi` → `nexus-agent`、`omp.sh` → `nexus.agent`（仅文案与标识，不动 API）
4. 配置目录：`~/.omp/` → `~/.nexus/`（环境变量 `OMP_*` → `NEXUS_*`）
5. 在 `LICENSE` 顶部增加 Nexus Agent 版权声明，保留 omp 原声明
6. 新建 `THIRD-PARTY-NOTICES.md`，登记 omp 来源
7. 保留 omp git 历史：`git log` 可追溯

**验收**：
- `bun install && bun run build:native && bun dev -- --version` 输出 `nexus x.y.z`
- `nexus --help` 文案无 omp 残留
- `~/.nexus/` 配置目录正确生成

**风险**：品牌字符串替换可能误伤 API/配置兼容性 → 仅替换可见文案，保留 `~/.omp/` 自动迁移逻辑（M8 再清理）

---

## M2 — 移植 Grok OS 沙箱（Landlock/Seatbelt）

**目标**：把 Grok 的 `xai-grok-sandbox` 移植为 `nexus-sandbox` Rust crate + NAPI 绑定，让 `bash` 工具可启用沙箱模式。

**输入**：`grok-build-main/crates/codegen/xai-grok-sandbox/`（Landlock + Seatbelt + seccomp + Profile）

**步骤**：
1. 在 `crates/nexus-sandbox/` 新建 Cargo 项目
2. 从 Grok 拷贝 `landlock.rs`、`seatbelt.rs`、`seccomp.rs`、`profile.rs`、`violation.rs`
3. 剥离 Grok 内部类型依赖（`xai-tool-runtime` 等），替换为 nexus 本地类型
4. 暴露 NAPI 接口：
   - `createSandbox(profile: 'workspace' | 'custom', opts): SandboxHandle`
   - `SandboxHandle.exec(cmd: string, args: string[]): Promise<ExecResult>`
   - `SandboxHandle.writeFile(path: string, content: Buffer): Promise<void>`
   - `SandboxHandle.readFile(path: string): Promise<Buffer>`
5. 在 `packages/nexus-sandbox/` 提供 TS 包装，对接 omp `bash` 工具
6. 配置项：`sandbox.enabled`、`sandbox.profile`、`sandbox.violationPolicy`
7. 在 `packages/coding-agent/src/tools/bash/` 增加 sandbox 执行路径（可选启用）
8. 单元测试：landlock/seatbelt 各 5+ 测试；集成测试：sandbox 下执行 `rm -rf /` 应被拒

**验收**：
- Linux 上 bash 工具在 sandbox 模式下无法写 `~/` 外文件
- macOS 上 Seatbelt 限制同等生效
- Windows 暂时降级为 ISO FS 隔离（M2.1 后续补 Job Objects）

**风险**：Grok sandbox 依赖 `nono` crate 与 Grok workspace 抽象 → 需要在 nexus 重建最小 workspace trait

---

## M3 — 移植 Grok Checkpoint/回滚系统

**目标**：把 Grok 的 checkpoint 系统移植到 nexus，支持任意时间点回滚工作区状态。

**输入**：`grok-build-main/crates/codegen/xai-grok-workspace/src/session/{checkpoint,checkpoint_store,file_state,swap_policy}.rs`

**步骤**：
1. 在 `crates/nexus-checkpoint/` 新建 Rust crate
2. 移植 `checkpoint_store.rs`（基于文件 hash + 增量存储）
3. 移植 `swap_policy.rs`（LRU + 大小限制）
4. 移植 `file_state.rs`（mtime + hash 索引）
5. 暴露 NAPI：
   - `CheckpointStore.create(label: string): CheckpointId`
   - `CheckpointStore.restore(id: CheckpointId): Promise<void>`
   - `CheckpointStore.list(): Checkpoint[]`
   - `CheckpointStore.diff(id): FileDiff[]`
6. TS 包装 `packages/nexus-checkpoint/`
7. 在 omp `bash`/`edit`/`write` 工具前自动打 checkpoint（可配置频率）
8. 新增 `/rewind` slash 命令调用 restore
9. 集成 ISO FS：checkpoint 优先走 reflink（btrfs/apfs），fallback 到 hash copy

**验收**：
- 编辑 5 个文件后 `/rewind <id>` 可完全恢复
- `~/.nexus/checkpoints/` 占用 < 工作区大小的 1.5×
- 单测覆盖 swap_policy LRU、并发 restore

**风险**：Windows 上无 reflink → 走 full copy，磁盘占用翻倍 → 文档说明 + 大小上限

---

## M4 — 吸收 Grok 多级 compaction

**目标**：把 Grok 的 inter/intra/code/history 四级 compaction 算法移植到 TS，作为 omp compaction 的替代。

**输入**：`grok-build-main/crates/codegen/xai-grok-compaction/src/{inter_compaction,intra_compaction,code_compaction,history}/`

**步骤**：
1. 阅读四级 compaction 的 observer/config/compact.rs，提取算法
2. 在 `packages/nexus-compaction/` 用 TS 重写：
   - `interCompaction`：跨 turn 压缩
   - `intraCompaction`：单 turn 内重复内容压缩
   - `codeCompaction`：代码块专用压缩（保留签名 + 注释占位）
   - `historyCompaction`：长期历史摘要
3. 适配 omp `packages/agent/src/compaction/` 接口（保持 API 一致）
4. 配置：`compaction.strategy: 'omp' | 'nexus' | 'hybrid'`
5. 基准测试：用 omp `snapcompact` 包的 SQuAD 评测对比 token 节省

**验收**：
- 同样 100 turn 会话，nexus 策略下 context token 比 omp 默认减少 ≥ 20%
- 压缩后 agent 仍能引用早期代码（不丢关键信息）
- benchmark 通过

**风险**：Grok compaction 依赖其 message 类型 → 需要做类型映射

---

## M5 — 移植 OpenClaude gRPC server

**目标**：把 OpenClaude 的 gRPC server 移植为 `packages/nexus-grpc/`，让 Nexus 可作为远程服务被 Python/Go/Rust 客户端调用。

**输入**：`openclaude-main/src/proto/openclaude.proto` + `scripts/start-grpc.ts` + `scripts/grpc-cli.ts`

**步骤**：
1. 拷贝 `openclaude.proto` 到 `packages/nexus-grpc/proto/nexus.proto`
2. 重命名 service/message：`OpenClaude` → `Nexus`
3. 生成 TS stubs（`@grpc/proto-loader`）
4. 实现 server，对接 omp `SessionManager` + `createAgentSession`
5. 暴露：`Prompt`、`SetModel`、`Abort`、`StreamTokens`、`ToolPermission`、`ActionRequired`
6. CLI 入口：`nexus grpc --port 50051`
7. 测试客户端：`nexus grpc-cli`
8. 文档：Python/Go/Rust 客户端示例

**验收**：
- `nexus grpc` 启动后，Python 客户端能发 prompt 收到流式 token
- 工具调用通过 `ActionRequired` 事件触发权限确认
- 端到端测试通过

**风险**：omp 的 SessionManager API 与 OpenClaude 原有 gRPC 实现差异大 → 需要 adapter 层

---

## M6 — 移植 OpenClaude VS Code 扩展

**目标**：把 OpenClaude 的 VS Code 扩展适配为 Nexus 扩展，可在 VS Code 中启动 nexus、查看流式输出、确认工具权限。

**输入**：`openclaude-main/vscode-extension/openclaude-vscode/`

**步骤**：
1. 拷贝整个目录到 `nexus-agent/vscode-extension/nexus-vscode/`
2. `package.json`：name/publisher/displayName/activationEvents 全部改为 nexus
3. 命令重命名：`openclaude.start` → `nexus.start`
4. 进程管理器：spawn `nexus` 而非 `openclaude`
5. 主题文件保留并重命名
6. 适配 M5 的 gRPC 协议（可选，默认走 stdio）
7. 发布到 VS Code Marketplace

**验收**：
- VS Code 中 `Cmd+Shift+P` → `Nexus: Start` 可启动会话
- 流式输出正确渲染
- 工具权限弹窗可确认

**风险**：OpenClaude 扩展依赖其特定协议 → 需要梳理协议字段

---

## M7 — 实现 per-agent 模型路由

**目标**：移植 OpenClaude 的 `agentModels` + `agentRouting` 配置，让不同 agent（Explore/Plan/frontend-dev 等）走不同模型。

**输入**：OpenClaude 的 `agentModels`/`agentRouting` JSON schema + omp `ModelRegistry`

**步骤**：
1. 在 `packages/nexus-routing/` 新建包
2. 配置 schema（`~/.nexus/config.json`）：
   ```json
   {
     "agentModels": { "deepseek": { "base_url": "...", "api_key": "..." } },
     "agentRouting": { "Explore": "deepseek", "default": "gpt-4o" }
   }
   ```
3. 桥接 omp `ModelRegistry`：路由命中时构造对应 Provider 实例
4. 集成到 omp `task` 工具的 subagent 调度路径
5. CLI：`nexus config routing` 交互式配置
6. 文档：路由优先级（explicit > routing > global）

**验收**：
- 配置后 `task` subagent 按路由走不同模型
- 全局 provider 不受影响
- 单测覆盖路由优先级

**风险**：omp 的 ModelRegistry 设计与 OpenClaude 不同 → 需要做适配层

---

## M8 — 统一 Nexus 品牌与 CLI 入口

**目标**：完成所有品牌迁移，删除 omp 残留，统一 CLI 体验。

**步骤**：
1. 全量审计 `omp`/`oh-my-pi`/`omp.sh` 残留（含代码注释、文档、asset 文件名）
2. 替换 asset：logo/icon/banner（用 Nexus 设计）
3. CLI 帮助、错误消息、TUI footer 全部改为 Nexus
4. 删除 M1 的 `~/.omp/` 自动迁移逻辑（M8 起不再兼容旧路径）
5. 文档站：`docs.nexus.agent`（占位）
6. 发布 v1.0.0-alpha

**验收**：
- `grep -ri "omp" nexus-agent/` 仅在 LICENSE/THIRD-PARTY-NOTICES/CHANGELOG 中出现
- `nexus --version` 显示 `1.0.0-alpha`

---

## M9 — 集成测试矩阵与发布流水线

**目标**：建立持续可发布的工程基础。

**步骤**：
1. CI 矩阵：
   - OS × Arch × Provider × 沙箱开关（关键组合 ~30 个）
2. 测试套件：
   - Bun test（unit）
   - cargo test per crate
   - PTY e2e（继承 omp）
   - gRPC 端到端
   - sandbox 安全测试（malicious payload）
3. Coverage：继承 omp `omp-stats` + OpenClaude coverage heatmap
4. Release：`scripts/release.ts`（继承 omp）+ npm publish + GitHub Release + 预构建二进制
5. 安全审计：`hardening:strict` + `verify:privacy`（继承 OpenClaude）
6. 文档：用户指南 + 集成指南 + 迁移指南

**验收**：
- CI 全绿
- `nexus install` 一键脚本可用（macOS/Linux/Windows）
- v1.0.0-beta 发布

---

## 时间预估（单人投入）

| 里程碑 | 工作量 | 累计 |
|---|---|---|
| M1 | 1 周 | 1 周 |
| M2 | 4 周 | 5 周 |
| M3 | 3 周 | 8 周 |
| M4 | 2 周 | 10 周 |
| M5 | 2 周 | 12 周 |
| M6 | 1 周 | 13 周 |
| M7 | 1 周 | 14 周 |
| M8 | 1 周 | 15 周 |
| M9 | 2 周 | 17 周 |

**约 4 个月到达 v1.0.0-beta。**

## 依赖关系

```
M1 → M2, M3, M5, M7, M8
M2 → M3（checkpoint 复用 sandbox workspace 抽象）
M3 → M4（compaction 需要 checkpoint 上下文）
M5 → M6（VSCode 扩展可选走 gRPC）
M1..M7 → M8 → M9
```

M2/M3 是关键路径，最大风险点。
