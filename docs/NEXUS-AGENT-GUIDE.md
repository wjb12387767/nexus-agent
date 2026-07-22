# Nexus Agent 深度解析:面向工程师的开源 AI 编码智能体权威指南

> **本文定位**:一篇可作为工程师入门与进阶参考的系统性介绍文章。基于对 nexus-agent 全部核心代码的逐文件深度阅读,从架构、流程、工具、协议、原生模块、安全、记忆、集成等多个维度展开,力求专业严谨又不晦涩。
>
> **读者画像**:有一定工程经验、希望理解 AI 编码智能体内部机制的工程师;正在评估是否采用 nexus-agent 的技术决策者;希望参与贡献或基于 nexus-agent 二次开发的开发者。
>
> **阅读建议**:第一遍可通读"序言 + 第一、二、三、十九、二十章"建立全局观;第二遍按兴趣深入各专题章节。各章节相对独立,可跳跃阅读。

---

## 序言

近两年,AI 编码智能体赛道从"单模型 + 简单工具调用"快速演化到"多模型 + 多工具 + 多安全机制 + 多协议接入"的复杂工程系统。开源社区涌现出多个旗舰项目,但每个项目都各有短板:有的工具丰富但缺乏 OS 级安全;有的有沙箱与回滚但工具链单薄;有的服务化成熟但模型广度不足。

Nexus Agent 的核心命题非常清晰:**把三个顶级开源项目各自"不可替代"的能力层,汇聚到同一个工程化基座上**。它以 [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) 为基座,移植 [Grok Build](https://github.com/xai-org/grok-build) 的 OS 级沙箱与检查点回滚,吸收 [OpenClaude](https://github.com/Gitlawb/openclaude) 的 gRPC 服务化与 VS Code 集成。最终产物是一个单一 CLI 入口 `nexus`,工业级安全 + 服务化 + 全模型广度三合一的开源 AI 编码智能体。

本文不旨在替代官方文档,而是试图回答一个更深层的问题:**当一个 AI 编码智能体被推向工业级时,它的内部到底长什么样?每一个设计决策背后的工程权衡是什么?**

---

## 第一章 项目溯源与定位

### 1.1 三大旗舰的不可替代能力

Nexus Agent 的能力来源映射如下:

| 来源 | 不可替代能力 |
|---|---|
| **omp**(基座) | 60+ 工具 · Hashline 编辑协议 · 50+ Provider · Mnemopi 记忆 · LSP+DAP · 多语言 eval · Collab 协作 |
| **Grok Build**(移植) | OS 级沙箱(Landlock/Seatbelt)· Checkpoint 回滚 · 多级 compaction |
| **OpenClaude**(移植) | gRPC server · VS Code 扩展 · per-agent 模型路由 · Bash AST 安全 walker |

这种"取各家之长"的融合策略并非简单代码拼凑,而是基于一个判断:**这三个项目各自解决了一类不同性质的问题,且互不重叠**。omp 解决的是"广度",Grok Build 解决的是"安全与可靠性",OpenClaude 解决的是"服务化与 IDE 集成"。

### 1.2 设计哲学:融合而非重写

[DESIGN.md](DESIGN.md) 第 8 节明确列出了"不做的事(YAGNI)":

- 不重写 omp 已有的工具实现
- 不引入 Grok 的 leader cluster 多进程架构(过重)
- 不引入 Grok 的 telemetry/Mixpanel(隐私优先)
- 不引入 OpenClaude 的 brands/models/vendors 三层抽象(omp 已有 catalog)
- 不做 Android/iOS 客户端

这些边界反映了核心工程纪律:**只移植"能力",不移植"包袱"**。Grok Build 的多进程架构、遥测、OpenClaude 的厂商抽象层,都是为它们各自产品形态服务的工程复杂度,在 Nexus 的 CLI-first 形态下要么过重,要么冗余。

### 1.3 与上游的关系

- **omp**:保持可 cherry-pick 的提交历史,定期同步上游
- **Grok Build**:作为只读镜像,按需 cherry-pick 特定 crate(其明确不接受外部贡献)
- **OpenClaude**:作为只读镜像,按需 cherry-pick gRPC/VSCode 部分

License 上,主协议为 MIT;omp 贡献保留原版权声明;Grok Build 移植代码保留 Apache-2.0 声明 + §4(b) 修改通知;OpenClaude 贡献保留 MIT 声明 + Anthropic 商标免责。详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 第二章 技术栈与工程基座

### 2.1 双语言架构:TypeScript + Rust

Nexus Agent 采用 **TS + Rust NAPI 混合架构**,这是当代高性能 AI Agent 的主流选择:

| 层 | 语言 | 角色 |
|---|---|---|
| 应用层 | TypeScript 7.0 | Agent 循环、工具编排、TUI、协议适配、业务逻辑 |
| 性能层 | Rust(stable toolchain) | 文件遍历、grep/glob、AST 解析、token 计数、shell、PTY、沙箱、checkpoint |
| 绑定层 | napi-rs 3.0 | Rust ↔ JS 跨语言调用 |

**为什么是 TS + Rust,而不是纯 TS 或纯 Python?**

- **TS 提供生态广度**:npm 生态里的 puppeteer、@modelcontextprotocol/sdk、xterm、react 等关键依赖几乎只在 JS 生态里成熟。
- **Rust 提供性能下限**:文件遍历、正则搜索、AST 解析这类 CPU 密集任务,纯 TS 实现会被 V8 的 JIT 抖动与 GC 暂停拖垮;Rust 的零成本抽象 + 无 GC 让性能可预测。
- **napi-rs 让两者无缝衔接**:Rust 编译为 `.node` 原生模块,JS 直接 `import`,如同普通 npm 包。

### 2.2 运行时选择:Bun 与 NAPI-RS

Nexus 选择 [Bun](https://bun.sh) ≥ 1.3.14 作为运行时,而非 Node.js。原因:

1. **启动速度**:Bun 的启动比 Node 快数倍,对 CLI 工具至关重要
2. **内置工具链**:Bun 内置 test runner、bundler、transpiler,减少依赖
3. **原生 TypeScript**:无需 tsc 预编译,直接跑 `.ts`
4. **SQLite 内置**:`bun:sqlite` 是 Mnemopi 的存储后端,无需 native 依赖

但 Bun 的 NAPI 兼容性比 Node 稍弱,因此项目中有大量针对 Bun 的兼容性 patch(见 [package.json](package.json) 的 `patchedDependencies`)。

**重要工程纪律**:[README.md](README.md) 明确指出"不要使用 nightly Rust 工具链,会导致原生模块兼容性问题"。stable Rust ≥ 1.92.0 是硬约束。

### 2.3 工程组织:Monorepo + Workspace

项目根目录是双 workspace:

- **Bun workspaces**(`packages/*`):TS 包,通过 `workspace:*` 协议互相引用
- **Cargo workspace**(`crates/*`):Rust crate,共享 `Cargo.lock` 与构建缓存

这种结构让 Rust 原生模块与 TS 包能够原子化协同演进——一个 PR 可以同时改 Rust 实现和 TS 接口,无需跨仓库协调。

### 2.4 构建、测试、CI

构建脚本链(见 [package.json](package.json) 的 `scripts`):

- `bun setup` — 安装 workspace 依赖 + 构建 native addon + link CLI
- `bun dev` — 启动 TUI 开发模式
- `bun run build:native` — 单独构建 Rust 原生模块
- `bun test` / `bun run test:ts` / `bun run test:rs` — 分层测试(TS / Rust)
- `bun run check` — 并行跑 TS 类型检查 + Rust clippy

测试体系分四层:

1. **单元测试**:per-package `bun test`
2. **集成测试**:`packages/coding-agent/test/integration/`,包括"破坏性回归测试"(沙箱拒绝 + checkpoint 恢复 + bash AST 双防线)
3. **PTY e2e 测试**:在真实终端环境验证 TUI 渲染
4. **Rust per-cargo 测试**:每个 crate 独立测试

Windows 用户可通过 `start.ps1` 一键启动:自动检测/安装 Bun + Rust、编译原生模块、启动 dev server。`start.ps1` 必须 UTF-8 with BOM 编码以正确显示中文。

---

## 第三章 顶层架构全景

### 3.1 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  集成层                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ TUI 渲染 │  │ gRPC     │  │ VS Code  │  │ SDK / 编程式嵌入│  │
│  │ 引擎     │  │ server   │  │ 扩展     │  │                 │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  应用层(packages/coding-agent)                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ Interactive│ │ Slash    │  │ MCP      │  │ Session Manager │  │
│  │ Mode     │  │ Commands │  │ Manager  │  │ + Tree          │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              60+ 内置工具 + 工具装配管线                  │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  Agent 运行时(packages/agent)                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ Agent    │  │ Compaction│ │ Doom Loop│  │ Pause/Steering/ │  │
│  │ Loop     │  │          │  │ Detector │  │ Proxy/Thinking  │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  AI 适配层(packages/ai + packages/catalog + nexus-routing)    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  50+ Provider 注册表  ·  14 种 API 协议  ·  5 种方言     │  │
│  │  流式调度 + 并发限流 + Auth 重试 + Usage 计费             │  │
│  │  Per-agent 路由 + Catalog 模型目录                       │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  编辑协议层(packages/hashline)                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  行锚定 + 内容哈希  ·  Block 块级编辑  ·  陈旧恢复       │  │
│  │  解析器状态机  ·  边界修复  ·  流式输出                   │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  记忆层(packages/mnemopi)                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  BeamMemory  ·  SQLite + FTS5  ·  Embedding + 向量检索   │  │
│  │  Recall 算法  ·  MMR 重排  ·  四层缓存  ·  Veracity 权重 │  │
│  └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  安全层(nexus-sandbox + nexus-checkpoint)                     │
│  ┌────────────────────┐  ┌─────────────────────────────────┐  │
│  │ Landlock/Seatbelt  │  │ Checkpoint 回滚                 │  │
│  │ seccomp 网络过滤   │  │ content-addressed blob          │  │
│  │ Bash AST 安全分析  │  │ LRU 驱逐策略                    │  │
│  └────────────────────┘  └─────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  原生性能层(crates/)                                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │pi-natives│ │pi-shell │ │pi-ast   │ │pi-iso   │ │pi-walker│  │
│  │31 子模块│ │会话shell│ │57 语言  │ │8 后端FS │ │高性能遍历│  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 包结构详解

`packages/` 下分四类:

**继承 omp 的核心包**:
- [packages/coding-agent](packages/coding-agent) — CLI 主入口、TUI、工具系统、会话管理
- [packages/agent](packages/agent) — Agent 运行时(agentLoop、compaction、thinking、pause、proxy)
- [packages/ai](packages/ai) — 50+ Provider、14 API、5 dialect、auth-retry、usage
- [packages/catalog](packages/catalog) — 12K+ 模型静态元数据、compat 构建、thinking 配置
- [packages/hashline](packages/hashline) — 行锚定编辑协议
- [packages/mnemopi](packages/mnemopi) — 本地记忆系统
- [packages/natives](packages/natives) — Rust NAPI 绑定的 JS loader

**新增的 Nexus 包**:
- `packages/nexus-sandbox` — Grok 沙箱 TS 绑定
- `packages/nexus-checkpoint` — Grok Checkpoint TS 层
- `packages/nexus-compaction` — Grok 多级 compaction 算法
- `packages/nexus-grpc` — OpenClaude gRPC server
- `packages/nexus-routing` — per-agent 模型路由
- `packages/nexus-bash-ast` — Bash AST 安全分析

**Rust crates** 见 `crates/`,见第九章详解。

### 3.3 数据流总览

一次完整的用户 prompt → Agent 响应的数据流:

```
User Input
  ↓
TUI InputController / gRPC Chat stream / SDK
  ↓
AgentSession.prompt(text)
  ├─ Slash command pipeline (extension / custom / file / template)
  ├─ Magic keywords injection (ultrathink / orchestrate / workflowz)
  └─ delivery: idle → agent.prompt / streaming → agent.steer or followUp
        ↓
Agent.#runLoop() → agentLoop() (packages/agent/src/agent-loop.ts)
  ├─ runLoopBody() 两层嵌套循环:
  │    外层: drain asides + follow-ups
  │    内层:
  │      1. pauseGate.waitUntilResumed()
  │      2. steeringQueue.dequeue() (250ms poll)
  │      3. appendOnlyContext.append(asides/followUps)
  │      4. resolveToolChoice(softReq, directive)
  │      5. streamAssistantResponse() → StreamFn → packages/ai
  │           └─ withGeminiThinkingLoopGuard
  │                └─ withProviderInFlightLimit (跨进程文件锁)
  │                     └─ streamDispatch → Provider module
  │                          └─ healLeakedThinking
  │      6. executeToolCalls(records)
  │           ├─ exclusive: 串行 Promise 链
  │           ├─ shared: 并行 + steering 轮询
  │           └─ toolResult 回填 appendOnlyContext
  ↓
AgentEvent → Agent.#emit() → listeners
  ↓
TUI TranscriptContainer / gRPC ServerMessage / SDK callback
```

---

## 第四章 Agent 运行时核心

Agent 运行时位于 [packages/agent](packages/agent),是整个系统的"心脏"。

### 4.1 Agent 类与 agentLoop 函数

设计上把"状态管理"与"循环算法"解耦:

- [agent.ts](packages/agent/src/agent.ts) — 有状态的 `Agent` 类,封装 `agentLoop` 并管理队列、监听器、Provider 会话状态
- [agent-loop.ts](packages/agent/src/agent-loop.ts) — 无状态的主循环实现(纯函数式)

这种分离的好处是:循环算法可独立测试、可重入;状态管理集中在 Agent 类。

**Agent 类的关键方法**:

| 方法 | 作用 |
|---|---|
| `prompt(input, options)` | 发起新一轮 prompt |
| `continue(options)` | 在流结束后续推 |
| `steer(message)` | 注入打断式用户插话 |
| `followUp(message)` | 注入 follow-up |
| `abort(reason)` | 中止当前流 |
| `waitForIdle()` | 等待 agent 进入空闲态 |
| `reset()` | 重置会话状态 |

### 4.2 双层嵌套循环

核心算法 `runLoopBody()` 采用两层嵌套:

**外层循环**:优先消费 `aside`(非打断性插话,如用户补充上下文),其次消费 `followUp`(紧接上一轮的追加提问)。每次外层迭代重新同步上下文(`appendOnlyContext` 追加,保证 prompt cache 命中)。

**内层循环**:每次迭代执行:
1. **Pause gate 检查** — `agentPauseGate.waitUntilResumed(signal)`,若被冻结则阻塞
2. **Steering dequeue** — 每 250ms(`STEERING_INTERRUPT_POLL_MS`)轮询打断式插话
3. **Context sync** — asides/follow-ups/steering 合并进上下文
4. **ToolChoice resolution** — 解析 `SoftToolRequirement` 与 `ToolChoiceDirective`
5. **streamAssistantResponse()** — 通过 `StreamFn` 调用 LLM
6. **executeToolCalls()** — 执行模型产出的工具调用

### 4.3 工具执行的并发模型

`executeToolCalls()` 维护两个执行槽:

- **`lastExclusive`**:exclusive 工具(如写文件)串行排队,前一个完成才执行下一个
- **`sharedTasks`**:shared 工具(如读文件)可并行,通过 Promise 链组合

每个工具 record 持有两种信号:
- `nonInterruptibleSignal`:工具必须跑完才能终止
- `interruptibleSignal`:工具感知 IRC(中断请求控制)abort

**Steering 轮询**:在 interruptible 工具在飞期间,每 250ms 检查 steering 队列;有 steering 时让 interruptible 工具看见 abort 信号,但 non-interruptible 工具不受影响。这种分级让 agent 既能高并发又能优雅响应打断。

### 4.4 流式优先与中断分级

整个系统贯彻"流式优先":

- `agentLoop` 返回 `EventStream<AgentEvent, AgentMessage[]>`
- Provider 调用通过 SSE 流式返回 token
- Hashline 编辑通过 `parsePatchStreaming` 流式解析
- TUI 在 LLM 还在产出时就开始处理工具调用与边界修复

中断分级是流式优先的必要配套:

| 概念 | 行为 |
|---|---|
| **abort** | 立即停止,中断所有工具(包括 non-interruptible) |
| **steer** | 中断当前流式响应,interruptible 工具看见 abort,non-interruptible 跑完 |
| **pause** | 在循环顶端的安全点冻结,不中断已在飞的工具 |
| **followUp** | 不打断,等当前轮结束后追加 |

### 4.5 Pause Gate、Steering、Follow-up

**Pause Gate**([pause.ts](packages/agent/src/pause.ts))是进程级单例 `agentPauseGate`,所有 agent loop 共享:

- `pause()` 关闭 gate,记录暂停时间戳
- `resume()` 打开 gate,返回暂停时长
- `waitUntilResumed(signal)` 在 gate 上 park,signal abort 时释放"等待者"但不打开 gate 本身

**核心语义**:pause 是"安全点冻结",不是 abort。已在飞的 non-interruptible 工具仍会跑完,避免在工具执行中途突然冻结导致资源泄露。

**Steering**:打断式插话,通过 250ms 轮询注入。在 interruptible 工具在飞期间让工具看见 abort 信号,但 non-interruptible 工具不受影响。Harmony 协议内容泄漏时抛 `HarmonyLeakInterruption`,恢复策略是 truncate-resume(最多 2 次)→ abort-retry(最多 2 次)。

**Follow-up**:不打断当前流,在当前轮结束后作为追加提问注入,通过 `appendOnlyContext.append()` 追加,保证 prompt cache 命中。

### 4.6 Soft Tool Requirement

`SoftToolRequirement` 字段:`{ soft: true, id, toolName, satisfies?, reminder }`

三阶段处理(关键在于不破坏 prompt cache):
1. **Remind** — 每个唯一 `id` 注入一次 reminder 到上下文
2. **Escalate** — 模型若仍拒绝使用该工具,将 soft 升级为 forced toolChoice(最多 3 次,`MAX_SOFT_TOOL_ESCALATIONS`)
3. **Force** — 通过 `ToolChoiceDirective` 强制模型调用指定工具

这个机制让 agent 既能尊重模型自主性,又能在关键工具(如 checkpoint、reflect)上保底。

### 4.7 Doom Loop 检测

[doom-loop-detector.ts](packages/agent/src/doom-loop-detector.ts) 实现:

- **滑动窗口**:`windowSize = 10`,FIFO
- **签名归一化**:`stableStringify()` 递归排序对象 key,`{a:1,b:2}` 与 `{b:2,a:1}` 同签名
- **检测**:从窗口末尾向前扫描连续相同签名,达到 `threshold = 3` 触发告警并自动 reset 窗口
- **行为**:只警告,不阻断 —— 给上层(compaction、用户介入)提供信号,而不是粗暴打断可能合法的重复操作(如批量重命名)

**局限性**:基于"完全相同签名",对参数微调的循环(如每次 offset+1 的分页)无法识别;不跨 session 持久化;仅 tool call 层面。

---

## 第五章 工具系统全景

工具系统位于 [packages/coding-agent/src/tools](packages/coding-agent/src/tools)。

### 5.1 工具装配管线

`createTools()` 装配算法(见 [tools/index.ts](packages/coding-agent/src/tools/index.ts)):

1. **解析 eval backends** — 决定 eval 工具的可用后端
2. **AST 配对自动包含** — 若包含 `grep` 则自动加入 `ast_grep`;若包含 `edit` 则自动加入 `ast_edit`
3. **记忆后端驱动** — 根据 memory backend 自动 include 对应 memory_edit/retain/recall/reflect/learn 工具
4. **autolearn 顶层挂载**
5. **`isToolAllowed()` 过滤** — 按用户设置/权限过滤
6. **`wrapToolWithMetaNotice()` 包装** — 给每个工具加元信息提示
7. **xdev registry 挂载** — 跨设备工具注册表

`ToolSession` 接口承载极丰富的会话上下文:cwd、hasUI、settings、fileSnapshotStore、conflictHistory、noopLoopGuard、asyncJobManager、mcpManager、toolChoiceQueue 等。

### 5.2 内置工具清单(口径说明)

> **口径严谨性说明**:项目自述与 README 常见"60+ 工具"表述,但更可验证的口径是——**`BUILTIN_TOOLS` Map 中顶层命名的公开工具约 29 项**(见下表);若计入 MCP 扩展工具(`mcp__<server>_<tool>`)、browser 子动作、eval 多语言后端、hub 异步 job、xdev 跨设备工具、隐藏工具(yield/goal)等,能力面确实更宽。本节按可验证的"顶层命名内置"口径列出,避免把"仓内存在"误读为"默认已注册"。

`BUILTIN_TOOLS` Map 中的公开工具:

| 类别 | 工具 |
|---|---|
| **文件操作** | read, write, edit, glob, grep |
| **代码搜索** | ast_grep, ast_edit |
| **Shell** | bash |
| **子任务** | task, hub, todo |
| **LSP/调试** | lsp, debug |
| **代码求值** | eval(Python REPL) |
| **浏览器** | browser |
| **图像** | inspect_image, generate_image |
| **Web** | web_search |
| **GitHub** | github |
| **状态管理** | checkpoint, rewind |
| **记忆** | memory_edit, retain, recall, reflect, learn |
| **技能** | manage_skill |
| **交互** | ask |

`HIDDEN_TOOLS`:`yield`(让出控制权)、`goal`(目标管理),不直接暴露给模型。

每个工具的详细说明见 [docs/tools/](docs/tools)。

### 5.3 Essential vs Discoverable

[essential-tools.ts](packages/coding-agent/src/tools/essential-tools.ts) 定义:

```
ESSENTIAL_BUILTIN_TOOL_NAMES:
  read, write, bash, edit, glob, eval, task, hub, learn, manage_skill
```

`defaultLoadModeForToolName(name)`:
- essential 工具 → "essential" 模式(始终顶层)
- 其他 → "discoverable" 模式(可被降级)

这个设计防止工具在重新注册时被静默降级 —— essential 工具一旦注册就保底可见。

### 5.4 EditTool 多模式编辑

[edit/index.ts](packages/coding-agent/src/edit/index.ts) 通过 4 个 `EditModeDefinition` 支持多模式:

| 模式 | 描述 |
|---|---|
| replace | 整文件替换 |
| patch | 传统 patch |
| **hashline** | 行锚定 + 内容哈希标签(**推荐**) |
| apply_patch | Aider 风格 apply_patch 协议 |

**LSP Writethrough**:编辑后触发 LSP 的 format + diagnostics。`createEditWritethrough()` 提供:
- `enableFormat` — 编辑后格式化
- `enableDiagnostics` — 编辑后诊断
- `diagnosticsDeduplicate` — 通过 `getDiagnosticsLedger(session).reduce()` 去重

**多文件聚合** `executeApplyPatchPerFile()`:多文件编辑共享一个 LSP batch,只有最后一个文件触发 flush(合并 format + diagnostics 为单次扫描)。任意文件失败立即停止,失败错误信息包含"已应用"与"未应用"文件清单。

### 5.5 task 工具与子任务派发

`task` 工具允许 agent 派发子任务。子任务的模型由 per-agent 路由决定(见第八章)。典型用法:

```
task(label="code-reviewer", prompt="审查 src/auth.ts")
```

会按 `agentModels` 配置匹配到 `deepseek/deepseek-coder` 模型。子任务通过 `learn` 工具回流经验到记忆系统。

---

## 第六章 Hashline 编辑协议

Hashline 是 omp 的核心创新之一,位于 [packages/hashline](packages/hashline)。它解决了传统 diff 在 LLM 编辑场景下的根本性问题。

### 6.1 与传统 diff 的差异

| 维度 | 传统 unified diff | Hashline |
|---|---|---|
| 锚定方式 | 字节范围偏移 | 行号 + 内容哈希标签 |
| 失效检测 | 无(静默错位) | 文件 hash 不匹配立即拒绝 |
| 块语义 | 无 | tree-sitter 块级解析 |
| 边界修复 | 无 | 自动修复 echo/分隔符失衡 |
| 陈旧恢复 | 无 | diff 驱动行重映射 |
| body 语义 | 增量描述 | 最终内容(body 即真相) |

**根本设计**:编辑 body 是目标文件的最终内容,不是增量。模型只需给出"替换后的样子",由 applier 负责落地。这极大降低了模型出错率。

### 6.2 数据模型

关键类型(见 [types.ts](packages/hashline/src/types.ts)):

- `Anchor { line: number }` — 1-indexed 行锚
- `Cursor` — `bof | eof | before_anchor(Anchor) | after_anchor(Anchor)`
- `Edit` 联合:
  - `insert { kind:"insert", cursor, body, blockStart? }`
  - `delete { kind:"delete", anchor, range:[start,end] }`
  - `block { kind:"block", anchor, op:"replace_block"|"delete_block"|"insert_after_block", body? }` — 延迟解析,由 tree-sitter 后端展开

### 6.3 解析器状态机

[parser.ts](packages/hashline/src/parser.ts) 的 `Executor` 类核心字段:`#edits`、`#pending`、`#fileOp`、`#skippableComments`。

关键导出:
- `parsePatch(input): Patch`
- `parsePatchStreaming(input): AsyncIterable<PatchEvent>` — 流式解析
- `detectApplyPatchContamination(input): boolean` — 拒绝 `*** Update File:` 与 `@@ -N,M +N,M @@` unified diff 头,防止模型把 apply_patch 与 hashline 混写

`#flushPending()` 处理 5 种 pending 类型:`replace` → 拆解为 before_anchor inserts + range deletes;`delete` → range deletes;`block` → 延迟(deferred),由 block.ts 后续解析;`insert_before/after/bof/eof` → 直接 insert edit。

`#stripBarePrefixesIfUniform()`:仅当所有 bare row 都带 `N:` 前缀时才剥离(避免误伤 YAML/dict 行号前缀)。

### 6.4 应用算法与边界修复

[apply.ts](packages/hashline/src/apply.ts) 的 `applyEdits(text, edits): ApplyResult` 是核心。

**关键正则**:
```
STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/    // 结构性闭合符
JSX_CLOSER_RE                                       // JSX 闭合符
```

**`repairReplacementBoundaries()` — 两遍修复**:
- Pass 1(局部修复):`findBoundaryEcho()`、`findOneSidedBoundaryEcho()`、`findDuplicateSuffix()` / `findDuplicatePrefix()`
- Pass 2(缺失闭合符修复):`findDroppedSuffixClosers()` 对整 patch 残留扫描,补回被吞掉的闭合符

**`computeDelimiterBalance()`**:跳过字符串/注释/模板字面量,跟踪 `()[]{}` 的净失衡。

**`repairAfterInsertLandings()`**:将错误锚定的 after-insert 滑动到其缩进所声明的深度。

**主流程**:
1. 丢弃 phantom deletes(范围实际为空)
2. 校验边界
3. `repairReplacementBoundaries()` 边界修复
4. `repairAfterInsertLandings()` 着陆点修复
5. 按行号分桶
6. 自底向上应用(避免行号漂移)
7. 处理 bof/eof 特殊位置

### 6.5 Block 块级编辑

[block.ts](packages/hashline/src/block.ts) 的展开规则(镜像 parser):

- `replace_block N:` → before_anchor inserts + range deletes
- `delete_block N` → 纯 deletes
- `insert_after_block N:` → after_anchor inserts,附 `blockStart` 标签

**边界处理**:`insert_after_block N:` 无法解析时 → 降级为普通 `insert after N:` 并 warning;单行 block 解析结果 → 拒绝(mis-anchor 检测)。

### 6.6 陈旧标签恢复

[recovery.ts](packages/hashline/src/recovery.ts) 的 `Recovery` 类基于 `SnapshotStore`:

`tryRecover(args)` 流程:
1. `store.byHash(path, fileHash)` 取快照(16 位 tag 冲突时取最新)
2. `replayRemappedAnchorsOnCurrent()` 重放

`buildLineMap(previousText, currentText)` 用 `Diff.diffArrays` 建立 previous→current 行号映射。

`validateRemappedAnchorContext()` 三种验证:
- 锚点行内容唯一 → `validateUniqueAnchorContext()`(任一侧邻居匹配即可)
- 锚点行内容重复 → `validateDuplicateAnchorContext()`(双侧邻居都必须匹配)
- 性能优化:`computeAnchorNeighbors()` 一次 O(anchors log anchors) 扫描替代 O(anchors²)

**失败闭合原则**:target 已变/被删/分裂/歧义时一律拒绝,让上层抛 `MismatchError` 并附带最新上下文,绝不"猜测"。

### 6.7 Seen-line 守卫

`Patcher`(见 [patcher.ts](packages/hashline/src/patcher.ts))的 seen-line 守卫:拒绝在 read/search 从未显示的行上做锚定编辑(防止盲改)。

关键常量:
```
SEEN_LINE_REVEAL_CAP = 40         // 单次拒绝错误中最多内联 40 行未见锚点
SEEN_LINE_REVEAL_MAX_COLUMNS = 512 // 每行最多 512 字符(防止 minified bundle 注入)
```

`enforceSeenLines: false` 时仅靠内容哈希校验。

**多 section 批处理**:`assertUniqueCanonicalPaths()` 同一文件不可有多个 section;任意 section isNoop → 抛错;中途写盘失败 → 报告已写/未写 section 列表。

---

## 第七章 AI Provider 联邦

AI 适配层是 nexus-agent 工程成熟度的最高体现,位于 [packages/ai](packages/ai)。

### 7.1 双层注册架构

**第一层:API 协议注册**([api-registry.ts](packages/ai/src/api-registry.ts))

定义 14 个内置 `KnownApi`:

```
"openai-completions", "openai-responses", "openrouter",
"openai-codex-responses", "azure-openai-responses",
"anthropic-messages", "bedrock-converse-stream",
"google-generative-ai", "google-gemini-cli", "google-vertex",
"ollama-chat", "cursor-agent", "gitlab-duo-agent", "devin-agent"
```

**编译期完整性检查**:
```typescript
type _MissingBuiltinApis = Exclude<KnownApi, (typeof BUILTIN_API_IDS)[number]>;
type _CheckBuiltinApis = _MissingBuiltinApis extends never ? true : [...];
true satisfies _CheckBuiltinApis;
```
强制 `BUILTIN_API_IDS` 数组必须覆盖所有 `KnownApi` 联合类型成员,否则编译失败。

**第二层:Provider 实体注册**([registry/registry.ts](packages/ai/src/registry/registry.ts))

50+ Provider 的单一注册表 `PROVIDER_REGISTRY`。每个 Provider 是一个文件(`registry/<id>.ts`),导出一个 `satisfies ProviderDefinition` 的对象。

例:`registry/anthropic.ts`:
```typescript
export const anthropicProvider = {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    envKeys: () => isFoundryEnabled()
        ? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
        : $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
    login: async (cb) => { const { loginAnthropic } = await import("./oauth/anthropic"); return loginAnthropic(cb); },
    refreshToken: async (credentials) => { ... },
    callbackPort: 54545,
    pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
```

`registry/openai.ts` 极简(因为 OpenAI 不需要 OAuth):
```typescript
export const openaiProvider = { id: "openai", name: "OpenAI" } as const satisfies ProviderDefinition;
```

### 7.2 SSoT + 派生结构

`PROVIDER_REGISTRY` 是 Provider 的**单一真理源(SSoT)**,所有派生结构都从它 filter/map 生成:

- `PASTE_CODE_LOGIN_PROVIDERS` — `PROVIDER_REGISTRY.filter(p => p.pasteCodeFlow)`
- `builtInOAuthProviders` — `PROVIDER_REGISTRY.filter(p => p.login && p.showInLoginList !== false)`
- `CALLBACK_PORTS` — 从 `callbackPort` 派生
- `serviceProviderMap` — 从 `envKeys` 派生

**添加 Provider = 一个新文件 + 一行 import + 一行数组项**。

同样的编译期完整性检查:
```typescript
type _MissingCatalogProviders = Exclude<KnownProvider, RegistryDef["id"]>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never ? true : [...];
true satisfies _CheckRegistryComplete;
```
强制 registry 必须覆盖 catalog 中所有 `KnownProvider`,避免"添加了模型但忘了加 provider"的遗漏。

### 7.3 14 种 API 协议

每个 API 协议对应一个 stream 函数,通过 `streamDispatch` 路由(见 [stream.ts](packages/ai/src/stream.ts) 第 767-903 行):

1. **Custom API** — extension 注册的自定义 API
2. **GitLab Duo** — 特殊谓词 `isGitLabDuoModel` + `gitlab-duo-agent` API
3. **Vertex AI** — 使用 ADC,不需要 api_key
4. **Bedrock** — 从 AWS env vars 或 profile 获取凭据
5. **API Key 校验** — `requestOptions.apiKey || getEnvApiKey(model.provider)`,缺失抛 `MissingApiKeyError`
6. **Vertex-authenticated model** — 如 `openai-completions` + Vertex Express URL
7. **14 个 case 分支** — 路由到对应 stream 函数

### 7.4 5 种方言适配

[dialect/](packages/ai/src/dialect) 为非 Anthropic/OpenAI 标准的模型提供 inband 工具调用解析:

| 方言 | 文件 | 标签格式 | 思考块 |
|---|---|---|---|
| **glm** | [glm.ts](packages/ai/src/dialect/glm.ts) | `<tool_call>...<arg_key>K</arg_key><arg_value>V</arg_value>...` | `<think>...</think>` |
| **kimi** | [kimi.ts](packages/ai/src/dialect/kimi.ts) | `<\|tool_calls_section_begin\|>...` | `<think>...</think>` |
| **qwen3** | [qwen3.ts](packages/ai/src/dialect/qwen3.ts) | `<tool_call>{"name":...}<tool_call>` | `<think>...</think>` |
| **gemma** | [gemma.ts](packages/ai/src/dialect/gemma.ts) | `<\|tool_call>call:NAME{key:value}<tool_call\|>` | `<\|channel>thought` |
| **xml** | [xml.ts](packages/ai/src/dialect/xml.ts) | `<invoke name="N"><parameter name="K">V</parameter></invoke>` | `<thinking>...</thinking>` |

每个方言实现 `InbandScanner` 接口,以**增量状态机**方式从文本流解析出 `InbandScanEvent`(text/thinkingStart/thinkingDelta/thinkingEnd/toolStart/toolArgDelta/toolEnd)。

**GLM 方言的精华 — `scanValueHeal`**:当模型输出 `<arg_value>` 后忘记关闭标签,scanner 扫描"修复签名":
- 错误关闭签名:`</arg_key>` 后跟 `<arg_key>` / `</tool_call>` / `</arg_value>`
- 缺失关闭签名:完整的 `<arg_key>...</arg_key><arg_value>` 序列

`ValueHealScan` 三态:`none` / `partial`(签名可能正在形成,需 hold back) / `heal`(确认修复)。

**Gemma 方言的独特性**:用 `<|"|>` 代替 ASCII 引号包裹字符串。所有解析逻辑(`splitTopLevel` / `matchDelim` / `findCallClose`)都必须跳过 `<|"|>` 字符串 span。

### 7.5 流式处理与并发限流

[stream.ts](packages/ai/src/stream.ts) 的核心调用链:

```
stream<TApi>(model, context, options?)
  └─ withGeminiThinkingLoopGuard(model, options,
       └─ withProviderInFlightLimit(model, opts,
            └─ streamDispatch(model, context, opts)))
```

**Provider In-Flight 限流**是工程上最复杂的部分——**跨进程文件系统锁**实现 per-provider 并发上限:

- `providerInFlightDir(provider)`:SHA-256 哈希 provider 名,放在 `~/.config/pi/run/provider-inflight/<hash>/`
- `acquireProviderInFlightLock`:使用 `fs.mkdir` 的原子性作为 mutex
- **心跳机制**:每 5 秒(`PROVIDER_INFLIGHT_HEARTBEAT_MS`)更新 lease 的 info.json
- **Stale 清理**:`PROVIDER_INFLIGHT_LEASE_STALE_MS = 30s` 后判定 lease 过期
- **进程存活检测**:`process.kill(pid, 0)` 探测 lease 持有进程是否还活着
- **唤醒机制**:fs.watch 监听 `.wakeup` 文件 + 250ms fallback timer,避免 busy-wait
- **Token-checked release**:释放锁前校验 token,防止误删其他进程的新锁

**Leaked-Thinking 修复**:`healLeakedThinking(model, inner)` 在 `withProviderInFlightLimit` 内部包裹所有 dispatch。第三方代理网关常把模型的 reasoning text 泄漏到 visible text channel,这个修复通过启发式识别 `<think>...</think>` 等标签把泄漏内容重新归类为 thinking。

**豁免规则**:anthropic + 官方 endpoint、openai + `api.openai.com`、openai-codex + `CODEX_BASE_URL` 不 healing;其他 provider 一律 healing。URL 检查严格:`new URL(baseUrl).hostname === "api.openai.com"`,防止 `api.openai.com.evil/` lookalike。

### 7.6 认证与重试

[auth-retry.ts](packages/ai/src/auth-retry.ts) 定义**三步序列**:

- **(a) initial**:`error === undefined, lastChance: false` → 本地缓存 token
- **(b) refresh-same**:`error !== undefined, lastChance: false` → 强制刷新同账号 token
- **(c) rotate-sibling**:`error !== undefined, lastChance: true` → 切换到兄弟凭据

`AUTH_RETRY_MAX_ATTEMPTS = 64` 是硬上限。

`resolveNextAuthRetryKey` 核心逻辑:
- `isDirectCredentialRotationError`(usage-limit / OAuth invalidated / 401)→ 跳过 refresh,直接 rotate
- 非 direct rotation:先 refresh-same,再 rotate-sibling
- 通过 `acceptRetryKey` 防止重复 key 和超限

**Replay-safe auth retry**(streamSimple):在第一个非 `start` 事件出现前,如果遇到可重试 auth 错误,buffer 所有 `start` 事件并返回 failure(不 emit),让外层用新 key 重试。一旦 emit 了任何非 start 事件(`emittedReplayUnsafeEvent = true`),后续错误直接 fail,不再重试(因为已经向用户展示了内容)。

**Error 分类系统**([error/flags.ts](packages/ai/src/error/flags.ts))是位标记:

```
ThinkingLoop    = 0x0001_0000
Transient       = 0x0002_0000
Timeout         = 0x0004_0000
UsageLimit      = 0x0008_0000
AuthFailed      = 0x0100_0000
Abort           = 0x0800_0000
Grammar         = 0x1000_0000
OAuthExpiry     = 0x4000_0000
```

`classify(error, api?)` 遍历 error chain,对每一层 instanceof 检查 + regex 匹配。Regex 模式极其详尽:`OVERFLOW_PATTERNS` 19 个模式覆盖 Anthropic/OpenAI/Google/xAI/Groq/Copilot/llama.cpp/LM Studio/MiniMax/Kimi 等。

### 7.7 Usage 计费统计

[usage.ts](packages/ai/src/usage.ts) 定义 provider 无关的计费模型:

```
UsageReport
├── provider, fetchedAt
├── limits: UsageLimit[]
│   ├── id, label
│   ├── scope: UsageScope (provider/accountId/projectId/orgId/modelId/tier/windowId/shared)
│   ├── window: UsageWindow (id/label/durationMs/resetsAt)
│   ├── amount: UsageAmount (used/limit/remaining/usedFraction/remainingFraction/unit)
│   └── status: "ok" | "warning" | "exhausted" | "unknown"
└── resetCredits: UsageResetCredits (availableCount + credits[])
```

**Credential Ranking Strategy** 实现智能凭据选择:
- `findWindowLimits(report, context)`:提取 primary(短窗口,如 5h)+ secondary(长窗口,如 7d)
- `scopeLimits(report, context)`:按 model 过滤 limit(per-model quota)
- `blockScope(context)`:provider-local backoff scope(一个 model family 耗尽不阻塞其他 family)
- `PRIMARY_WINDOW_HOT_FRACTION = 0.85`:短窗口用量达 85% 时降级

每个 Provider 有独立的 usage 实现(`usage/claude.ts`、`usage/openai-codex.ts`、`usage/gemini.ts` 等)。

---

## 第八章 模型目录与路由

### 8.1 Catalog 静态元数据

[packages/catalog](packages/catalog) 是模型元数据的单一来源:

- **数据源**:`models.json`(约 12K 模型,lazy 加载)
- **`getModelRegistry()`**:lazy 单例,首次调用时遍历 models.json,用 `buildModel(spec)` 构建 `Map<provider, Map<id, Model>>`
- **`calculateCost(model, usage)`**:按 `model.cost.input/output/cacheRead/cacheWrite`(每百万 token 单价)计算

### 8.2 Model 构建

[build.ts](packages/catalog/src/build.ts) 是唯一的 Model 构造器,解析顺序是依赖链:

1. **compat**:URL/provider/id 检测,解析为完整 record
2. **thinking**:从 identity + resolved compat 派生

`buildCompat(spec)` 按 `spec.api` 分派:`openrouter` → `buildOpenRouterCompat`;`openai-completions` → `buildOpenAICompat`;`anthropic-messages` → `buildAnthropicCompat` 等。

**关键设计原则**(注释):"Request handlers read fields — they never detect, parse ids, or allocate compat per request."——所有检测在构建时完成,请求时只读字段。这避免了请求路径上的重复探测开销。

`OpenAICompat` 接口极其详尽:`supportsStore` / `supportsDeveloperRole` / `supportsMultipleSystemMessages` / `supportsReasoningEffort` / `reasoningEffortMap` / `supportsUsageInStreaming` / `enableGeminiThinkingLoopGuard` / `maxTokensField` 等——所有这些都在 build 时检测。

### 8.3 Per-agent 路由

[packages/nexus-routing](packages/nexus-routing) 从 OpenClaude 的 `agentModels` / `agentRouting` 设计移植,适配 Nexus 的 ModelRegistry 架构。

**配置形态**:
```json
{
  "agentModels": {
    "deepseek-v4-flash": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-..."
    },
    "zai-default": {
      "model": "glm-5.1",
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "sk-..."
    }
  },
  "agentRouting": {
    "Explore": "deepseek-v4-flash",
    "Plan": "gpt-4o",
    "default": "gpt-4o"
  }
}
```

- `agentModels`:routeKey → OpenAI 兼容端点配置
- `agentRouting`:agent 标识 → routeKey

### 8.4 路由解析优先级

[resolver.ts](packages/nexus-routing/src/resolver.ts) 的 `resolveAgentRouting` 实现 4 级优先级:

1. **explicit**:`toolSpecifiedModel` 非空且为 agentModels key — task 工具显式指定 model,绕过持久配置
2. **routing**:agentRouting 表按 `agentName` / `subagentType` 命中
3. **default**:agentRouting.default 命中
4. **global**:全部未命中 → 返回 `null`,回落到 omp 全局 provider

`normalizeAgentKey`:`key.toLowerCase().replace(/[-_]/g, "")` — case-insensitive、hyphen/underscore-agnostic 匹配。

**ModelRegistry 桥接**([registry-bridge.ts](packages/nexus-routing/src/registry-bridge.ts))是关键解耦层:

- 不直接 import omp ModelRegistry 类(避免循环依赖),定义最小 `ModelRegistryLike` 接口
- 单次注册全部 agentModels 条目(omp 单 provider 单 baseUrl/apiKey 限制)
- 幂等:通过 `configFingerprint` 缓存(JSON.stringify agentModels)
- OpenAI 兼容:`api` 固定 `"openai-completions"`

合成 provider 名:`NEXUS_ROUTING_PROVIDER_NAME = "nexus-routing"`;modelPattern 格式 `nexus-routing/<routeKey>`。

---

## 第九章 Rust 原生模块

Rust 原生层由 7 个 crate 组成,通过 NAPI-RS 暴露给 JS。

### 9.1 NAPI 绑定模式

Nexus 使用 10 种 NAPI 绑定模式:

1. **同步函数** `#[napi] pub fn foo(opts) -> Result<T>`:轻量操作
2. **`task::Promise<T>`**(`task::blocking`):CPU-bound 长任务,在 libuv worker 跑,支持 CancelToken
3. **`PromiseRaw<'env, T>`**(`task::future`):需要 tokio runtime 的 async 任务
4. **`#[napi] pub struct X` + `impl X`**:有状态对象(Shell、PtySession、SandboxHandle)
5. **`#[napi(object)]`**:DTO
6. **`#[napi(string_enum)]` / `#[napi] pub enum X`**:枚举
7. **`#[napi(js_name = "...")]`**:重命名
8. **ThreadsafeFunction**:流式回调(`on_chunk`)
9. **`#[module_init]`**:在 `.node` 加载时同步执行一次
10. **`Unknown<'env>`**:统一 AbortSignal 接入

**Windows Tokio/Rayon 自定义线程池**(见 [pi-natives/src/lib.rs](crates/pi-natives/src/lib.rs)):Windows 上必须自定义 runtime,避免 OS 提交超过实际允许的线程数导致 `os error 1455`(commit limit 崩溃)。`NAPI_TOKIO_MAX_WORKER_THREADS = 4`、`RAYON_MAX_THREADS = 8`。

**版本哨兵**:`#[napi(js_name = "__piNativesV17_0_2")]` — JS loader 校验 `.node` 与 package.json 版本一致。

### 9.2 pi-natives:31 个子模块

pi-natives 是最大的 crate,包含 31 个子模块。关键模块:

**ast-grep 结构化搜索**([ast.rs](crates/pi-natives/src/ast.rs),1455 行):
- 6 级 strictness:Cst/Smart/Ast/Relaxed/Signature/Template
- 有界保留 Top-N:`BinaryHeap` 仅保留 `offset + limit + 1` 条匹配,避免一次性物化
- 多语言编译模式:每个模式按所有出现的语言预编译
- 重叠编辑去重:同 span 同 replacement 折叠
- 原子写入:所有文件都成功 apply 后再 flush

**Bash AST 安全分析**([bash_ast.rs](crates/pi-natives/src/bash_ast.rs),356 行):
- `MAX_COMMAND_LENGTH = 10_000`、`MAX_NODES = 50_000`、`PARSE_TIMEOUT = 50ms`
- tree-sitter-bash 解析,超时/超节点 → `aborted: true`
- 与沙箱双防线:AST 安全分析在前,沙箱 deny 在后

**Ripgrep 封装**([grep.rs](crates/pi-natives/src/grep.rs),3247 行):
- 三级回退:Rust regex → PCRE2 → 字面量
- 并行/串行/窗口流式三模式
- 大文件延迟两阶段:pass 1 Full,>4MB 文件 defer 到 pass 2 Prefix
- thread-local SearchWorker 缓存
- `MAX_FILE_BYTES = 4 MiB`

**会话化 Shell**([shell.rs](crates/pi-natives/src/shell.rs),595 行):
- `Shell` 持 `Arc<CoreShell>`,委托到 pi-shell crate
- chunk 桥接器:`flume::bounded(64)` + `pump_chunks` 同步 `call_async` 形成背压
- 修复 issue #4078:bounded queue + 同步 call_async,子进程被自己 pipe 阻塞而非把多余数据塞进内存
- Minimizer 集成:命令输出最小化

**PTY 会话**([pty.rs](crates/pi-natives/src/pty.rs),623 行):
- `PtySession { core: Arc<Mutex<Option<PtySessionCore>>> }` — Mutex 保证同一时刻只有一个活跃会话
- Windows ConPTY 特殊处理:`PTY_STARTUP_TIMEOUT = 5s`、写 `\x1b[1;1R` 应答光标查询、`drop(master)` 在独立线程上跑
- UTF-8 流式解码:64 KiB + 4 字节缓冲
- 取消流程:TERM_SIGNAL → 等 300ms → KILL_SIGNAL

**进程管理**([ps.rs](crates/pi-natives/src/ps.rs) + [pi-shell/process.rs](crates/pi-shell/src/process.rs),2081 行):

**跨平台进程身份固定**(防 PID 复用):
- Linux:`pidfd_open` + `pidfd_send_signal`(替代 `kill(pid, sig)`)
- macOS:`proc_bsdinfo.pbi_start_tvsec/usec` 三元组
- Windows:`OpenProcess` + `GetProcessTimes` creation_time(NT 句柄在 PID 复用后仍指向原进程)

`SpawnRegistry`(关键修复 issue #4605):在 spawn-observer 钩子中**立即**捕获 `Process` handle,不在 cancel 时重 lookup。`PRUNE_THRESHOLD = 64` 通过 `next_sweep_at` 水位线避免 O(n²) 的每 spawn 扫描。

**工作剖面器**([prof.rs](crates/pi-natives/src/prof.rs),242 行):
- always-on 设计:`PROFILE_BUFFER` 容量 10,000 样本(~60s 高活)
- `profile_region(name)` 返回 RAII `ProfileGuard`,Drop 时记录 `ProfileSample { stack, duration_us, timestamp_us }`
- NAPI 导出 `get_work_profile(last_seconds)`:返回 folded + summary + SVG flamegraph
- 被 `task.rs` 中所有 `Blocking<T>::compute` 包裹

**Kitty 键盘协议**([keys.rs](crates/pi-natives/src/keys.rs),1721 行):
- `LEGACY_SEQUENCES: phf::Map` O(1) 完美哈希,~70 条 escape 序列
- 解析器分支:`parse_csi_u` / `parse_csi_1_letter` / `parse_functional` + `parse_modify_other_keys`
- 修复 tmux/Zellij mixed mode、Ghostty super+alt+backspace、小键盘数字等回归

**Token 计数**([tokens.rs](crates/pi-natives/src/tokens.rs),70 行):
- 两套 BPE 表:`O200k`(GPT-4o/o1/GPT-5,默认)+ `CL100K`(GPT-3.5/GPT-4)
- 多字符串时 Rayon 并行 `par_iter`,返回总和(避免 per-element napi crossing)

**SIXEL 图像编码**([sixel.rs](crates/pi-natives/src/sixel.rs),54 行):PNG/JPEG/WebP/GIF → SIXEL escape 序列,Lanczos3 resize。

### 9.3 pi-shell:嵌入式会话化 shell

[pi-shell](crates/pi-shell) 基于 brush-core 包装:

**协作式取消**([cancel.rs](crates/pi-shell/src/cancel.rs),164 行):
- `Flag { reason: AtomicU8, notifier: Notify }`
- `CancelToken { deadline: Option<Instant>, flag: Option<Arc<Flag>> }`
- `wait()`:`tokio::select! { by_flag, by_timeout }` 等先触发者
- `AbortToken(Weak<Flag>)`:外部句柄,可被丢弃不影响 CancelToken

**ChildSessionAction**(`child_session_action(interactive, stdin_is_terminal, in_pipeline)`):
- `TakeForeground`:交互式 + 终端 stdin → 取前台(支持 Ctrl+C)
- `DetachSession`:非终端 stdin → `setsid` 脱离主机会话(防 SIGTTIN 主机)
- `None`:非交互式 + 终端 stdin

**uutils builtins**([coreutils.rs](crates/pi-shell/src/coreutils.rs)):把 vendored + patched uutils 的 `run` 入口注册为 brush_core builtins,通过 `pi_uutils_ctx::scope` 在 blocking 线程上跑。`run_caught` 用 `catch_unwind` 包装,panic → 1 + "internal error" 到 stderr(防止 BrokenPipe 拖垮长寿命 host)。

**输出最小化器**([minimizer.rs](crates/pi-shell/src/minimizer.rs)):命令输出重写,支持 git/pipeline:gradle 等 filter;`original_text` 持久化为 `artifact://<id>` 并替换为引用。

### 9.4 pi-ast:57 语言 AST

[pi-ast](crates/pi-ast) vendored ast-grep-language v0.39.9,扩展至 57 种语言。

**关键宏**:
- `impl_lang!($lang, $func)`:stub 语言
- `impl_lang_expando!($lang, $func, $char)`:带 `expando_char` 的语言,`pre_process_pattern` 把 `$$$`/`$A-Z_` 替换为 expando 字符(如 Rust 用 `µ`、C 用 `𐀀`)

**`LANG_ALIASES: phf_map!`**:>200 条静态别名表(`"rs" => Rust`、`"ts" => TypeScript`、`"sh"/"bash"/"zsh" => Bash`)。

**源代码摘要**([summary.rs](crates/pi-ast/src/summary.rs),1376 行):
- `ElidableForest { SpanNode { span, children } }`:DFS 收集可折叠节点
- BFS unfold:从所有 root 折叠开始,逐步用子节点替换父节点直到可见行数达 `unfold_until`
- per-language 表:`is_comment_kind` / `is_elidable_kind` 覆盖 57 种语言
- import run 折叠:连续 `use_declaration` (Rust) / `import_statement` (TS) 满足 `min_body_lines` 时折叠中间行

**Repo Map**([repomap.rs](crates/pi-ast/src/repomap.rs),891 行):
- 常量:`DEFAULT_MAX_LINES = 200` / `DEFAULT_MAX_FILES = 2000` / `DEFAULT_MAX_SYMBOLS_PER_FILE = 40`
- mtime desc 排序:最近编辑的文件优先占用预算
- 跨文件耦合评分 `compute_reference_scores`:`HashMap<symbol_name, HashSet<file_path>>` 反向索引
- `score_file`:`(symbol_count+1).ln() + (references+1).ln() * 2.0`

### 9.5 pi-iso:8 后端 FS PAL

[pi-iso](crates/pi-iso) 是跨平台文件系统隔离 PAL(Portable Abstraction Layer),8 后端 + 1 trait:

| 后端 | 平台 | 核心调用 |
|---|---|---|
| **Apfs** | macOS | `libc::clonefile(src, dst, 0)` 单 syscall 递归 reflink |
| **Btrfs** | Linux | `btrfs subvolume snapshot` O(1) 可写快照 |
| **Zfs** | Unix | `zfs snapshot` + `zfs clone -o mountpoint` |
| **LinuxReflink** | Linux | `FICLONE` ioctl (`0x4004_9409`) |
| **Overlayfs** | Linux | `mount("overlay", ..., "overlay", 0, opts)` |
| **WindowsBlockClone** | Windows | `FSCTL_DUPLICATE_EXTENTS_TO_FILE` |
| **Projfs** | Windows | `ProjectedFSLib.dll` + 5 回调 |
| **Rcopy** | 跨平台 | git worktree 或 recursive copy |

**`IsolationBackend` trait**(async):`kind`/`probe`/`start`/`stop`/`diff`。

**优先级与回退**:`auto_order` 按平台给出优先级列表,`resolve(preferred)` 按序探测,`fell_back` 标记退化。

**统一 diff**([diff.rs](crates/pi-iso/src/diff.rs)):`default_diff` 通过 `merged/.git` 是否存在走 git 或 walk 模式,与后端无关。

### 9.6 pi-walker:高性能遍历

[pi-walker](crates/pi-walker) 是平台无关目录遍历原语。

**共享缓存**([cache.rs](crates/pi-walker/src/cache.rs),669 行):
- `CACHE_TTL_MS`(默认 1000ms)、`EMPTY_RECHECK_MS`(默认 200ms)、`MAX_CACHE_ENTRIES`(默认 16)
- `WALK_POOL` Rayon 池,thread_name = `pi-walker-{i}`
- `SCAN_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>>` 共享缓存
- `CacheKey { root, options }`:options.cache 字段在 key 计算时设为 false(避免递归键)
- `parallel_for_each`:`PARALLEL_MIN_FILES = 256` 阈值以下串行

**关键设计**:`HEARTBEAT_INTERVAL = 128`(每 128 个 entry 检查一次 CancelToken),`WalkDecision` 谓词钩子返回 Include/Skip/SkipDescend/Stop。

### 9.7 任务调度与取消

所有长任务统一走 `task::CancelToken`:

- `heartbeat()`:在关键节点检查(每 128 entry / 每个文件 / 每个 chunk 处理 tick),Err 时立刻退出
- `wait()`:异步等待 abort 或 timeout,先触发者赢(`tokio::select!`)
- `aborted()`:同步检查
- `AbortToken(Weak<Flag>)`:外部句柄,可被丢弃不影响 CancelToken

`task::blocking<T>(tag, ct, work)` 与 `task::future(env, tag, async {})` 是所有异步 NAPI 操作的统一入口。`Blocking<T>::compute` 在 libuv worker 跑 `profile_region(self.tag)` + `catch_unwind`,panic 通过 `crash_handler::blocking_task_panic_scope` 捕获并转 `Status::GenericFailure`。

---

## 第十章 沙箱安全系统

[nexus-sandbox](crates/nexus-sandbox) 移植自 Grok Build,Apache-2.0。

### 10.1 多机制组合

| 平台 | deny | read-write | read-only | default-read | 网络 | 进程隔离 |
|---|---|---|---|---|---|---|
| Linux | bwrap bind-over | Landlock | Landlock | Landlock | seccomp BPF | bwrap re-exec |
| macOS | sandbox-exec deny | allow file-write | allow file-read | allow file-read* | deny network | sandbox-exec |
| Windows | 无内核强制 | pi-iso PAL | pi-iso PAL | pi-iso PAL | 直接 Command | 无 |

### 10.2 Landlock 后端

[landlock.rs](crates/nexus-sandbox/src/landlock.rs),371 行:

- `ABI::V4`(包含 truncate 支持)
- 默认 read:`add_path_rule(ruleset, Path::new("/"), AccessFs::from_all(abi) | AccessFs::Truncate)`
- read-only 路径:`AccessFs::from_read(abi)`
- read-write 路径:`AccessFs::from_all(abi) | AccessFs::Truncate`
- 设备文件 `DEVICE_FILES`:`/dev/null`、`/dev/zero`、`/dev/random`、`/dev/urandom`、`/dev/tty`、`/dev/ptmx`、`/dev/fd`
- **Landlock 没有 deny_path**:deny 在 bwrap re-exec 时通过 bind-over 处理
- `restrict_self()` 应用到当前进程(**不可逆**)

**bwrap re-exec**(`bwrap_reexec_command`):
- `--bind / /` 整体 bind
- deny_write 路径 `--ro-bind`
- deny_read 路径 `--ro-bind <placeholder> <path>` 用 `bwrap_blocked_placeholder`(mode 000 文件/目录,放 `nexus_home/sandbox-blocked[|-dir].{pid}`)
- PID 后缀避免并发 race
- 已在 bwrap 内(env `__NEXUS_INSIDE_BWRAP` 已设)返回 None,防嵌套

### 10.3 Seatbelt 后端

[seatbelt.rs](crates/nexus-sandbox/src/seatbelt.rs),487 行:

`(version 1)` + `(deny default)` + 显式 allow。

**`SEATBELT_WRITE_DENY_ACTIONS`**:`file-write-data`/`file-write-create`/`file-write-unlink`/`file-write-mode`/`file-write-owner`/`file-write-flags`/`file-write-times`/`file-write-setugid` — 每个具体写子动作 deny 让 deny 不论发出顺序都胜出(last-match 语义)。

**`macos_path_aliases(path)`**:返回原始路径、canonical 形式、以及每个的 `/private` firmlink 别名(`/tmp` ↔ `/private/tmp`、`/var` ↔ `/private/var`、`/etc` ↔ `/private/etc`),避免通过别名绕过 deny。

### 10.4 Windows ISO FS 降级

Windows 没有 Landlock/Seatbelt 等价机制。Nexus 使用 Projected FS(ISO FS)实现降级隔离:

- 创建一个 ISO 文件作为虚拟工作区
- Agent 的所有文件操作重定向到 ISO 内
- 写操作通过 overlay 落到宿主磁盘(隔离区)

**限制**:无法限制网络;无法限制子进程访问宿主文件系统;需要管理员权限(首次创建 ISO 时)。建议生产环境用 Linux/macOS。

### 10.5 seccomp 网络过滤

[seccomp.rs](crates/nexus-sandbox/src/seccomp.rs),140 行:

`install_child_network_filter()`(unsafe,pre_exec 上下文):
- 阻断 `connect`/`bind`/`sendto`/`sendmsg`/`listen`/`accept`/`accept4` 7 个网络 syscall
- BPF 程序:加载 syscall 号 → 逐个 JEQ 检查 → 命中跳 ERRNO → 默认 ALLOW
- `SECCOMP_RET_ERRNO | EPERM_VAL` 返回 EPERM
- 先 `prctl(PR_SET_NO_NEW_PRIVS, 1)`,再 `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)`

非 Linux 平台 no-op。

### 10.6 Profile 系统

[profile.rs](crates/nexus-sandbox/src/profile.rs),644 行:

`SandboxProfile { name, read_only, read_write, deny, default_read, restrict_network }`

`ProfileName` enum:`Workspace` / `Devbox` / `ReadOnly` / `Strict` / `Off` / `Custom(String)`

**`load_sandbox_config(workspace)`**:
- 全局配置:`~/.nexus/sandbox.toml`
- 项目配置:`<workspace>/.nexus/sandbox.toml`(仅可加)
- `merge_project_profiles`:用 `entry().or_insert()` 让全局已定义的名字不被项目覆盖(**防恶意工作区掏空全局 profile**)

各 profile 的语义:
- **Workspace**:`read_write = essential_writable_paths(workspace)`,`default_read = true`
- **Devbox**:枚举 `/` 顶级目录加入 read_write,排除 `/data`、`/proc`、`/sys`、`/dev`
- **ReadOnly**:`read_write = essential_writable_paths_minimal()`,`restrict_network = true`
- **Strict**:`default_read = false`,显式 read_only 列表,`restrict_network = true`
- **Custom(name)**:从 config.profiles 查找,`extends` 基础 profile

### 10.7 Bash AST 安全分析

[bash_ast.rs](crates/pi-natives/src/bash_ast.rs),356 行:

**安全策略**:
- `parse_bash_command` 用 `tree-sitter::Parser` + `tree_sitter_bash::LANGUAGE`
- 空命令返回 None
- 命令长度 > 10000 直接 abort
- 遍历超 50,000 节点 / 超 50ms / 解析失败 → `aborted: true`
- 递归 `build_bash_node` 每节点检查预算与超时,任一触发即 `return None` 向上短路传播

**双防线**:AST 安全分析(allowlist + varScope 跟踪 + `declare -n` nameref 检测)在前,沙箱 deny 在后。Fail-closed:parse failure falls back to regex approver。

---

## 第十一章 Checkpoint 回滚系统

[nexus-checkpoint](crates/nexus-checkpoint) 移植自 Grok Build,Nexus 重写移除 `xai-grok-config`/`xai-grok-paths`/`xai-hunk-tracker`,改用 `std::path` + `sha2` + `pi-iso`。

### 11.1 双层存储

**磁盘布局**:
```
<cwd>/.nexus/rewind-checkpoints/
  .gitignore                              # "*"
  <session_id_hash>/
    checkpoint-<prompt_index>.json        # RewindCheckpoint 元数据
    blobs/
      <sha256_hex>                        # content-addressed blob
```

**内存**:`Mutex<BTreeMap<usize, Arc<RewindCheckpoint>>>`(prompt_index → checkpoint),热路径不读盘。

`DEFAULT_CHECKPOINT_CAP = 64` + `TMP_WRITE_SEQ: AtomicU64`(并发安全 temp 文件名)。

### 11.2 content-addressed blob

`persist(checkpoint)` 流程:
1. 跳过低于保留窗口的 checkpoint
2. `ensure_store_dirs` 创建目录 + `.gitignore`(内容 `*\n`)
3. `write_blobs_for_checkpoint`:每个文件快照内容以 sha256 为 key 写入 blob 目录,temp 文件 + rename 原子写,已存在则跳过去重
4. `write_checkpoint_file`:序列化 checkpoint JSON,temp + rename + `sync_all`
5. 插入 cache,`pop_first` 驱逐超 cap 的最旧 checkpoint
6. `apply_swap_policy` 额外驱逐

**reflink 探测**:`pi_iso::backend_kind()` 决定是否能用 CoW(Apfs/Btrfs/Zfs/LinuxReflink),否则全量拷贝。所有平台用 sha256 content-addressed blob 去重,**磁盘占用 < 1.5× 工作区**。

### 11.3 文件状态跟踪

[file_state.rs](crates/nexus-checkpoint/src/file_state.rs),864 行:

- `sha256_hex(bytes)`:sha2 计算
- **`FileHashMemo`**:`(path, size, mtime_ms) → sha256` memo 表,`hash_file` 命中 memo 直接返回
- **`FlexiblePath` enum**:Relative / Absolute,自定义 serde
- **`FileSnapshot`**:path + content + hash + mtime_ms + captured_at
- **`RewindPoint`**:prompt_index + created_at + file_snapshots(before)+ after_snapshots
- **`FileStateTracker`**:`begin_prompt(prompt_index)` / `end_prompt(prompt_index)`(捕获 after 快照)/ `capture_file_state(path, cwd)`(跳过工作区外)

**`rewind_files(tracker, target_prompt_index)`**:
1. 收集每个文件最早的 before 快照
2. 检测冲突(current vs after)
3. 还原磁盘(before Some → write;None → delete)
4. 仅无错误时 `tracker.truncate_from(target)`

### 11.4 驱逐策略

[swap_policy.rs](crates/nexus-checkpoint/src/swap_policy.rs),425 行:

`SwapPolicyConfig { max_checkpoints: 64, max_size_bytes: 256 MiB, max_age_secs: 7 days }`

`from_policy_str`:
- `"lru"`(默认)/`"lru-size"`(默认)
- `"fifo"`(max_age_secs=0)
- `"none"`(全部 MAX)

`SwapPolicy::evaluate(stats, now_secs)`:
1. 数量超 cap → LRU 排序驱逐最旧
2. 大小超 max_size_bytes → LRU 排序驱逐直到满足
3. 年龄超 max_age_secs → 标记可驱逐(不强制)

### 11.5 冲突检测

`restore_checkpoint_files(checkpoint, cwd)` → `FileRewindResponse`:
- 遍历 `checkpoint.fs.file_snapshots`,对每个 (flex_path, before_snapshot):
  - 读当前文件 → 与 `after_snapshots` 比对:相等 → clean_files;不等 → 判定 `ConflictType::DeletedExternally`/`CreatedExternally`/`ModifiedExternally`,加入 conflicts(**不阻断回滚**)
  - 写回:before 为 Some → `tokio::fs::write`;None → 删除当前文件
- 返回 `FileRewindResponse { success, target_prompt_index, reverted_files, clean_files, conflicts, error }`

---

## 第十二章 Compaction 上下文压缩

Compaction 位于 [packages/agent/src/compaction](packages/agent/src/compaction)。

### 12.1 5 种策略

```
"context-full" | "handoff" | "shake" | "snapcompact" | "off"
```

`DEFAULT_RESERVE_TOKENS = 16384`

关键函数:`compact()` / `prepareCompaction()` / `generateSummary()` / `generateHandoff()` / `findCutPoint()` / `estimateTokens()` / `shouldCompact()` / `resolveThresholdTokens()`。

### 12.2 Cut-Point 检测

`findCutPoint()` 算法:从消息序列末尾向前遍历,累计 token 直到超过 `keepRecentTokens`,然后向前找最近的"合法切点"。

**合法切点**:user message / assistant message / bashExecution / hookMessage / branchSummary / compactionSummary

**非法切点**:`toolResult` —— 切在 toolResult 会破坏工具-结果配对,导致下游 LLM 解析失败。

这个设计保证了压缩后保留段的消息结构合法。

### 12.3 Nexus Precompaction (LLM-free)

[nexus-precompact.ts](packages/agent/src/compaction/nexus-precompact.ts) 集成 `@nexus-agent/compaction` 包提供 LLM-free 压缩。

`NexusPrecompactMode`:`"off" | "code" | "code-intra" | "code-intra-inter"`

`precompactWithNexus()` 三阶段管线:
1. `codeCompaction` — 代码段压缩
2. `intraCompaction` — 消息内压缩
3. `interCompaction` — 跨消息压缩

**容错**:每阶段用 `unknown` 类型转换做结构化 typing,捕获错误后回退到原始消息(保证 LLM-free 失败不影响主流程)。

### 12.4 Shake 外科切除

[shake.ts](packages/agent/src/compaction/shake.ts),429 行:

**设计哲学**:机械地丢掉重内容,不调用 LLM。

`DEFAULT_SHAKE_CONFIG`:
- `protectTokens: 16000` — 受保护最近段大小
- `minSavings: 4000` — 最小节省阈值(不达标则不执行)
- `fenceMinTokens: 400` — fence 块最小 token

Region 类型:
- `ToolResultShakeRegion` — 工具结果区域
- `BlockShakeRegion` — fenced code block(``` 或 ~~~)与顶层 XML 元素

`scanTextForBlockRanges()`:检测 ``` 与 ~~~ fence,检测顶层 XML 开闭标签;fence 内的 XML 被抑制(防止误把代码示例当 XML 切)。

**关键规则**:被标记为 `useless` 的 tool result 绕过 protect window(即使它在受保护段内也被切除)。这让 agent 能丢掉"已无价值的冗长工具输出"。

### 12.5 多级回退链

`compact()` 主流程:

```
1. (可选) nexus precompaction  — LLM-free 结构化预处理
2. V2 远程压缩 (OpenAI Responses streaming)  — 首选
3. V1 远程压缩                                — 回退
4. 本地 summarization                         — 最终兜底
     ├─ 历史段 summarize
     └─ (若 split) turn-prefix summarize  — 并行
5. short summary 生成
6. file ops upsert                            — 文件操作登记
```

每个关键能力都有多级回退:LLM 调用(proxy V2 → V1 → 本地);Compaction(nexus precompact → remote V2 → V1 → local summary → shake);Hashline 编辑(tree-sitter block → 降级为 line-range → recovery → mismatch 报错)。

### 12.6 Append-Only Context Manager

整个 compaction 与 agent loop 都基于 append-only 上下文管理器:
- 消息只追加,不修改 —— 保证 prompt cache 命中率
- compaction 通过追加 `compactionSummary` 消息实现"逻辑删除"
- steering/follow-up 也以追加方式注入

---

## 第十三章 记忆系统 Mnemopi

[Mnemopi](packages/mnemopi) 是 nexus-agent 的本地记忆系统,提供长期记忆存储与检索。

### 13.1 BeamMemory 架构

`BeamMemory` 是顶层类,持有 `db`、`dbPath`、`sessionId`、`authorId/Type`、`channelId`、`useCloud`、`eventEmitter`、`pluginManager`、`annotations`、`triples`、`episodicGraph`、`veracityConsolidator`、`caches`、`pendingExtractions`。

`normalizeConfig` 把 `BeamMemoryOptions` 折叠为 `BeamConfig`:
- `workingMemoryLimit=1000`
- `workingMemoryTtlHours=24`
- `recencyHalflifeHours=72`
- `vecWeight=0.5` / `ftsWeight=0.3` / `importanceWeight=0.2`

### 13.2 存储层

- **数据库引擎**:`bun:sqlite`,启用 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`、WAL 模式
- **事务模型**:通过 `Symbol("mnemopi.txState")` 在 `Database` 对象上挂载嵌套深度计数,实现可重入的 `transaction` / `transactionAsync`
- **核心表**:`working_memory`、`episodic_memory`、`scratchpad`、`triples`、`annotations`、`memoria_facts`、`memoria_timelines`、`memoria_kg`、`memoria_instructions`、`memoria_preferences`、`consolidation_log`
- **FTS5 虚拟表**:`fts_working` / `fts_episodes`
- **ID 生成**:`sha256(content\0isoTime\0nonce)[:16]`,nonce 来自进程级 `Uint32Array(2)` 随机种子 + 自增计数器

### 13.3 Recall 算法

Recall 是系统最复杂的部分([core/beam/recall.ts](packages/mnemopi/src/core/beam/recall.ts)):

1. **Query 预处理**:tokenize(Unicode `\p{L}\p{N}_`,过滤 STOP_WORDS)、同义词扩展、`expandedTokenGroups` 保留 token 组结构
2. **Temporal 推断**:`extractTemporal(query, queryTime)` 从自然语言提取事件日期
3. **候选生成**(三路):FTS / Vector / Fallback
4. **Veracity 权重**:stated/true/likely_true=1.0,unknown=0.8,inferred=0.7,imported=0.6,tool=0.5,false=0
5. **Lexical relevance**:单 token 按出现次数 0.7~1.0;多 token `(exact + 0.5*partial) / count`
6. **Recency 衰减**:`exp(-ageHours / halfLifeHours)`,默认半衰期 72 小时
7. **Temporal boost**:相对 queryTime 的指数衰减
8. **Current-sensitive 调整**:查询含 "now/current/latest" 时,内容含 "current" 加成 ×1.35
9. **融合**:加权和 `vec*vecW + fts*ftsW + importance*impW`,叠加 veracity 系数、recency、temporal、current 调整
10. **MMR 重排**(可选)
11. **内容预览裁剪**:默认 500 字符
12. **Recall count 更新**:命中后 `UPDATE ... SET recall_count = recall_count + 1`

### 13.4 MMR 重排

[mmr.ts](packages/mnemopi/src/core/mmr.ts):

```typescript
mmrRerank<T>(results, lambdaParam=0.7, topK=10, similarityFn=jaccardSimilarity)
```

- 先按 `score` 降序,取最高分作为首个选中项
- 每轮遍历 remaining,对每个候选计算其与所有已选项的最大相似度 `maxSim`
- `mmrScore = λ * relevance - (1-λ) * maxSim`,选最大者
- 默认相似度 `jaccardSimilarity`(基于词集合的交并比)

### 13.5 Embedding 系统

[embeddings.ts](packages/mnemopi/src/core/embeddings.ts):

- **本地路径**:`fastembed`(Rust/ONNX runtime),默认模型 `BAAI/bge-small-en-v1.5`,缓存目录 `~/.hermes/cache/fastembed`
- **API 路径**:OpenRouter/OpenAI 兼容 endpoint
- **路由判定**:`isApiEmbeddingModel` — 模型名以 `openai/` 开头 / 包含 `text-embedding` / base URL 非 openrouter 域
- **Query cache**:进程内 `LRUCache<string, Vector>` (max 512),cache key 包含 provider id、model name、base URL,避免同进程多 Mnemopi 实例的 cache 串扰
- **VecType**:`float32` / `int8` / `bit`,默认 `int8`(二值化向量走 `binary_vector` BLOB 列)

### 13.6 四层缓存

[query-cache.ts](packages/mnemopi/src/core/query-cache.ts):

- **Tier1**:精确 query 字符串命中(内存 Map)
- **Tier2/3**:基于 embedding 相似度的命中(内存 Map)
- **Tier4**:持久化 SQLite `query_cache` 表,启动时从磁盘加载
- 统计:hits/misses/hit_rate/tier1_hits/tier2_hits/tier3_hits/tier4_hits

### 13.7 与 Coding-Agent 集成

设置 `memory.backend: mnemopi` 启用。三种 scoping:
- `global`(一个共享 bank)
- `per-project`(项目隔离)
- `per-project-tagged`(项目本地写 + 全局召回)

autoRecall 在会话首轮注入 `<memories>` 块;autoRetain 每 N 轮(默认 4)写入 retain bank。

LLM 模式:`smol`(pi-ai smol 模型)/`remote`(OpenAI 兼容)/`none`。

---

## 第十四章 MCP 集成

Nexus 内置深度 MCP(Model Context Protocol)集成,扩展 agent 能力。

### 14.1 三种传输协议

| Transport | 必需字段 | 用途 |
|---|---|---|
| `stdio`(默认) | `command` | 启动子进程,通过 stdin/stdout JSON-RPC |
| `http`(Streamable HTTP) | `url` | POST JSON-RPC,`Mcp-Session-Id` 跟踪 session |
| `sse`(legacy, 2024-11-05) | `url` | GET 打开 SSE 流 + POST 端点 |

**变量替换**:
- 发现时 `${VAR}` 和 `${VAR:-default}` 递归展开
- 连接前 stdio `env` 与 http `headers` 的值:
  1. 以 `!` 开头 → 跑 shell 命令(10s 超时),取 trimmed stdout
  2. 否则若命名了环境变量且非空 → 用环境值
  3. 否则用字面值

### 14.2 四大内置集成

| Integration | Source | Capability |
|---|---|---|
| **Playwright MCP** | microsoft/playwright-mcp | 20+ browser tools via accessibility snapshots |
| **Docling MCP** | docling-project/docling-mcp | PDF/Word/PPT/Excel/EPUB → Markdown,OCR + table extraction |
| **Qdrant MCP** | qdrant/mcp-server-qdrant | Production-grade vector database |
| **LightRAG MCP** | HKUDS/LightRAG | Knowledge graph RAG,5 retrieval modes |

四个全部走 `stdio` transport。配置见 [mcp.json.example](mcp.json.example)。

### 14.3 运行时生命周期

1. **SDK 启动**:`createAgentSession()` 中 `enableMCP` (默认 true) 时:
   - Headless/SDK:await `discoverAndLoadMCPTools()` 合并到 `customTools`
   - Interactive/TUI:立即构造 `MCPManager`,延迟到 session live 后 `discoverAndConnect()`
2. **发现**:`loadAllMCPConfigs` 通过 capability discovery 解析配置
3. **并行连接**(`MCPManager.connectServers`):每个 server 串行执行:存 source metadata → 跳过已连 → `validateServerConfig` → `#resolveAuthConfig` → `connectToServer` → wire OAuth refresh + `onClose` reconnect → `listTools` → cache → best-effort 加载 resources/templates/prompts/subscriptions
4. **Fast startup gate**:`connectServers()` 在"所有任务完成 vs `STARTUP_TIMEOUT_MS=250ms`"之间 race。250ms 后:已完成的变 live `MCPTool`;失败的记 error;仍 pending 的若有 cache 用 `DeferredMCPTool`
5. **工具暴露**:`discoverAndLoadMCPTools()` 把 manager tools 转 `LoadedCustomTool[]`,注册到 session tool registry 时命名为 `mcp__<server>_<tool>`
6. **Live reload**:`/mcp reload` = `disconnectAll` + `discoverAndConnect` + `session.refreshMCPTools(...)`
7. **Teardown**:`disconnectServer(name)` 清 pending/source/config/subscription、detach `onClose`、关 transport、按 `mcp__${name}_` 前缀过滤移除工具

### 14.4 配置与发现

**首选位置**:`.nexus/mcp.json`(项目)/ `~/.nexus/agent/mcp.json`(用户)。兼容 `.nexus/.mcp.json`、根目录 `mcp.json`、`.mcp.json`。

**Profiles 隔离**:`nexus --profile <name>` 时用户 scope 切换到 `~/.nexus/profiles/<name>/agent/mcp.json`。

**Auth**:`auth` 块(`type: oauth|apikey`、`credentialId`、`tokenUrl`、`clientId`/`clientSecret`、`resource`)与 `oauth` 块。凭据 id 派生自 `mcp_oauth:profile:<profile>:<url>`,project-scoped 定义跨 profile 安全(每 profile 独立授权)。

**重连**:传输层不重连、不重试(除 OAuth 单次 refresh 重试);manager 层负责 `transport.onClose` 触发 `reconnectServer(name)`,backoff 500/1000/2000/4000ms,5 次/30s 风暴熔断。

---

## 第十五章 TUI 渲染引擎

TUI 引擎位于 [packages/coding-agent/src/modes](packages/coding-agent/src/modes),核心契约见 [docs/tui-core-renderer.md](docs/tui-core-renderer.md)。

### 15.1 Append-only scrollback

**核心问题**:渲染器无法观测终端 scroll 位置(ConPTY 探测说谎,POSIX 无 API),老引擎尝试猜测导致 yank/flash/corruption。

**解决方案**:**native scrollback 永不重写**。

记账模型:
- **`committedRows` (C)**:帧 `[0, C)` 已物理滚入 history,**不可变**
- **`windowTopRow` (W)**:帧 row W 映射到 grid row 0,可见窗口是 `[W, W+height)`
- **commit boundary**(由组件树每帧报告):
  - **byte-stable end (B)** = `commitSafeEnd ?? liveRegionStart ?? frame.length`,B 下方断言永不 re-layout
  - **durable end (D)** = `max(B, snapshotSafeEnd ?? B)`
- **`auditRows` (A ≤ C)**:byte-stable 前缀,audit 只采样 `[0, A)`
- 每帧:`W = max(C, L - height)`、`C' = max(C, min(D, W))`,只有 `frame[C, C')` chunk 进入 history

### 15.2 渲染管线

`#doRender` 流程:
1. **Compose**:`render(width)` 收集 `liveRegionStart` / `commitSafeEnd` / `snapshotSafeEnd`
2. **Audit committed prefix**(`findCommittedPrefixResync`):采样 prefix 尾部(最近 24 行中最多 8 个非空行,SGR-stripped)。≤1 mismatch 视为对齐;任何 insertion/deletion 让下方所有行偏移 → 在首个变化行 re-anchor C,history 保留 stale 副本 + 新副本(**duplication, never loss**)
3. **Classify**:`fullPaint` 或 `update`
4. **Window math**:Overlay 冻结 commit;Shrink into committed prefix 时 re-anchor
5. **Extract cursor marker**(strip-first:marker 永不到达 terminal/prefix ledger/audit),prepare lines,slice window,composite overlays
6. **Emit** 之一:
   - `#emitFullPaint` — 手势(home + frame + window rows;`clearScrollback` 时 ED3 清 history)
   - `#emitUpdate` scroll-append — 离屏行恰好是 chunk
   - `#emitUpdate` in-window diff — 无滚动无 commit
   - `#emitUpdate` seam rewrite — commit 推进 / window re-anchor

**ED3 (`CSI 3 J`) 只在 `#emitFullPaint({ clearScrollback: true })` 一处发射**,且只对手势(session replace/branch/resume、mux 外 resize、Ctrl+L)。普通 update 永不发 ED2/ED3 或绝对 cursor home。

### 15.3 不变量(MUST / NEVER)

1. 永不新增 `CSI 3 J` callsite
2. 永不重写 committed row (`< C`),且 `W ≥ C` 永远成立
3. Commits 恰好是 chunk(`C' - C`)
4. 永不探测 viewport 位置或 update 路径中 fork on platform(win32 行为同 POSIX)
5. Mutable content 必须在 commit boundary 下方
6. Hardware cursor 停在真实 content bottom
7. Cursor 写入必须在 synchronized-output frame 内,ESU 之前
8. Render hot path 永不抛(overwide lines 用 `truncateToWidth` 钳制)
9. Mux 无破坏性 clear、无 history rewrap on resize
10. Ledger math / emitters / seam 的任何改动必须通过 stress harness 验证

### 15.4 能力探测

`TERMINAL` profile 在 import 时一次性从 `TERMINAL_ID` + 环境 sniff 解析:

- `shouldEnableSynchronizedOutputByDefault`:DEC 2026 默认开;precedence:用户 opt-out → 用户 force-on → `TERM_FEATURES` 广告 `Sy` → `WT_SESSION` → 已知 direct terminals → off for risky mux/unknown
- `detectRectangularSgrSupport`:DECCARA fills 仅 kitty
- `supportsScreenToScrollback`:kitty 的 ED22

### 15.5 宽度模型

统一 UAX#11 宽度模型:
- 快速路径:printable ASCII 一格/字符
- ASCII 之外通过 `Bun.stringWidth`(**pinned 到同一 native 模型**:Rust `unicode-width`)
- OSC 66 sized spans 按 `scale × (explicit w ?? payload width)` 加回
- Tab 按 `DEFAULT_TAB_WIDTH` 列加回

---

## 第十六章 会话管理

会话管理位于 [packages/coding-agent/src/session](packages/coding-agent/src/session),详见 [docs/session.md](docs/session.md)。

### 16.1 JSONL 持久化

**On-Disk Layout**:`~/.nexus/agent/sessions/<dir-encoded>/<timestamp>_<sessionId>.jsonl`

`<dir-encoded>` 取决于 canonicalized cwd:
- home 内:`-<relative-path>`(`/`、`\\`、`:` 替换为 `-`)
- OS temp 内:`-tmp-<relative-path>`
- 其他:legacy `--<cwd-without-leading-slash>--`

**Blob store**:`~/.nexus/agent/blobs/<sha256>`。Image blocks base64 长度 ≥ 1024 → 外化到 blob ref `blob:sha256:<hash>`。

### 16.2 Entry 类型

JSONL,一行一个 JSON object。Line 1 总是 `SessionHeader`(`type: "session"`,含 `version: 3`、`id`、`timestamp`、`cwd`、`title`、`titleSource`、`parentSession`)。

Entry 类型:
- `message`(AgentMessage,含 role/provider/model/content/usage)
- `thinking_level_change`(`off|minimal|low|medium|high|xhigh|max`)
- `model_change`(`model`、`role: default`)
- `service_tier_change`
- `compaction`(`summary`、`shortSummary`、`firstKeptEntryId`、`tokensBefore`)
- `branch_summary`(`fromId`,branch from root 时是字面 `"root"`)
- `custom`(extension state,被 `buildSessionContext` 忽略)
- `custom_message`(extension-provided,参与 LLM context)
- `label`(`targetId`、`label`)
- `ttsr_injection`(`injectedRules: string[]`)
- `session_init`(`systemPrompt`、`task`、`tools`)
- `mode_change`(`mode: plan`、`data: { planFile }`)

### 16.3 树与 Leaf 语义

`SessionManager` 持有 `SessionEntryIndex`:
- `#entriesById: Map<string, SessionEntry>`
- `#children: Map<string | null, SessionEntry[]>`
- `#labels: Map<string, string>`
- `#leaf: string | null` — 树中当前位置

三个 leaf movement primitive:
1. `branch(entryId)`:验证存在 → `leafId = entryId`,不写新 entry
2. `resetLeaf()`:`leafId = null`,下次 append 创建 root entry
3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`:`leafId = branchFromId`,append `branch_summary` entry

`getTree()` 是运行时 projection(parent links → children arrays,缺 parent 视为 root,children 按 timestamp 老→新排序);持久化仍是 append-only JSONL。

### 16.4 Context 重建

`buildSessionContext`:
1. 定 leaf
2. Walk `parentId` 链 leaf → root,reverse 为 root→leaf path
3. 派生 runtime state:`thinkingLevel`、`serviceTier`、model map、`injectedTtsrRules`、mode
4. 构建 message list:`message` 直通;`custom_message` → `createCustomMessage`;`branch_summary` → `createBranchSummaryMessage`;若 path 上有 `compaction`:先 emit compaction summary,然后从 `firstKeptEntryId` 到 compaction 边界 emit kept messages

### 16.5 /tree vs /branch

- **`/tree`**(同 session file 导航):`AgentSession.navigateTree()`。Flow:validate target + compute abandoned path → emit `session_before_tree` → 可选 summarize abandoned entries → 计算 new leaf → apply (`branchWithSummary` / `resetLeaf` / `branch`) → rebuild context + emit `session_tree`

  重要:summary entries attach 在**新 navigation position**,而非 abandoned branch tail。

- **`/branch`**(新 session file):`SelectorController.showUserMessageSelector` → `AgentSession.branch`。Branch source 必须是 **user message**;selected user root (`parentId === null`) → `newSession({ parentSession: previousSessionFile })`;否则 `createBranchedSession(selectedEntry.parentId)` fork 历史

---

## 第十七章 Slash 命令与 Skills

### 17.1 Capability discovery

Slash commands 是 capability(`id: "slash-commands"`,key 为命令名)。Capability registry 加载所有 provider,按 priority 降序,dedup by key,**first wins**。

**Provider 优先级**:
1. `native`(nexus)— 100
2. `omp-plugins`(extension packages)— 90
3. `claude` — 80
4. `claude-plugins` — 70
5. `agents`(`.agent`/`.agents` 标准目录)— 70
6. `codex` — 70
7. `opencode` — 55

Tie:同优先级保持注册顺序。

### 17.2 多 Provider 源路径

| Provider | 路径 |
|---|---|
| `native` | `.nexus/commands/*.md`(项目)+ `~/.nexus/agent/commands/*.md`(用户) |
| `claude` | `~/.claude/commands/**/*.md`(递归)+ `<cwd>/.claude/commands/**/*.md` |
| `codex` | `~/.codex/commands/*.md` + `<cwd>/.codex/commands/*.md` |
| `opencode` | `~/.config/opencode/commands/*.md` + `<cwd>/.opencode/commands/*.md` |
| `claude-plugins` | `<pluginRoot>/commands/*.md`,命令名前缀 `<plugin>:<command>` |

### 17.3 文件命令展开

`expandSlashCommand(text, fileCommands)`:
- 仅当 text 以 `/` 开头
- 解析命令名 + 参数(`parseCommandArgs`:简单 quote-aware splitting)
- 精确名匹配 loaded `fileCommands`
- 应用:位置替换 `$1`/`$2`、切片替换 `$@[start]`/`$@[start:length]`、聚合替换 `$ARGUMENTS` 和 `$@`、`prompt.render` 模板渲染

### 17.4 Skills 技能系统

Skill 是文件支持的能力包,发现后暴露给模型:lightweight metadata 在 system prompt、按需通过 `read` 工具读 `skill://...`、可选 interactive `/skill:<name>` 命令。

**目录布局**:`<skills-root>/<skill-name>/SKILL.md`(**非递归一层**)。

**SKILL.md Frontmatter**:`name`、`description`、`globs: string[]`、`alwaysApply`、`hide`、`disableModelInvocation`。

**Discovery 三轮**:
1. Capability providers via `loadCapability("skills")`
2. Custom directories via `scanSkillsFromDir(..., { requireDescription: true })`
3. Managed (auto-learn) skills 最后解析,first-wins

**`skill://` URL**:`skill://<name>` → 该 skill 的 `SKILL.md`;`skill://<name>/<relative-path>` → 该 skill 目录内的相对路径。Guard:拒绝绝对路径、拒绝 `..` traversal、resolved path 必须留在 `baseDir` 内。

### 17.5 Magic Keywords

| Keyword | 效果 |
|---|---|
| `ultrathink` | 让 agent 仔细推理 multi-step task;automatic thinking 激活时选当前模型支持的最高 reasoning effort |
| `orchestrate` | 切换 agent 到 multi-agent orchestration contract |
| `workflowz` | 让 agent 用 `task` 工具构建并运行 deterministic multi-subagent workflow |

**匹配规则**:精确小写、standalone(identifiers/inflections/paths/extensions 不匹配)、忽略 fenced code blocks 与 inline code spans。

---

## 第十八章 编程式集成

### 18.1 gRPC 双向流

[packages/nexus-grpc](packages/nexus-grpc) 暴露**一个双向流 RPC `Chat`**,所有交互通过同一条流上的 `ClientMessage` / `ServerMessage` 完成:

| 消息方向 | 类型 | 说明 |
|---|---|---|
| Client → Server | `ClientMessage.request` (`ChatRequest`) | 会话握手:`message`、`working_directory`、`model`、`session_id` |
| Client → Server | `ClientMessage.input` (`UserInput`) | 对 agent 提问的应答(`prompt_id` 关联) |
| Client → Server | `ClientMessage.cancel` (`CancelSignal`) | 取消当前生成 |
| Server → Client | `ServerMessage.text_chunk` | LLM 流式文本块 |
| Server → Client | `ServerMessage.tool_start` | agent 开始使用工具 |
| Server → Client | `ServerMessage.tool_result` | 工具返回结果 |
| Server → Client | `ServerMessage.action_required` | 请求人工介入(`CONFIRM_COMMAND` 或 `REQUEST_INFORMATION`) |
| Server → Client | `ServerMessage.done` | 生成完成(含 token 统计) |
| Server → Client | `ServerMessage.error` | 严重错误 |

启动:
```sh
nexus grpc --port 50051
```

### 18.2 多语言客户端

完整示例见 [docs/integration-guide.md](docs/integration-guide.md),支持 Python(`grpcio`)、Go(`google.golang.org/grpc`)、Rust(`tonic` + `prost`)。

Python 客户端示例:

```python
import grpc
from nexus_pb2 import ClientMessage, ChatRequest, UserInput, CancelSignal
from nexus_pb2_grpc import NexusStub

channel = grpc.insecure_channel("127.0.0.1:50051")
client = NexusStub(channel)

def chat(prompt: str, model: str = "claude-3-5-sonnet-20241022"):
    def request_iter():
        yield ClientMessage(request=ChatRequest(
            message=prompt,
            working_directory=".",
            model=model,
            session_id="demo",
        ))

    stream = client.Chat(request_iter())
    for msg in stream:
        kind = msg.WhichOneof("event")
        if kind == "text_chunk":
            print(msg.text_chunk.text, end="", flush=True)
        elif kind == "tool_start":
            print(f"\n[tool_start] {msg.tool_start.tool_name}({msg.tool_start.arguments_json})")
        elif kind == "tool_result":
            tag = "[ERR]" if msg.tool_result.is_error else "[OK]"
            print(f"\n[tool_result]{tag} {msg.tool_result.tool_name}: {msg.tool_result.output}")
        elif kind == "action_required":
            a = msg.action_required
            allow = not (a.type == a.CONFIRM_COMMAND and "rm -rf" in a.question)
            yield ClientMessage(input=UserInput(
                prompt_id=a.prompt_id,
                reply="y" if allow else "n",
            ))
        elif kind == "done":
            print(f"\n[done] tokens={msg.done.prompt_tokens}+{msg.done.completion_tokens}")
            break
        elif kind == "error":
            print(f"\n[error] {msg.error.message} (code={msg.error.code})")
            break
```

### 18.3 VS Code 扩展

安装后通过命令面板 `Nexus: Start` 启动会话。配置:

```json
{
  "nexus.transport": "stdio",          // "stdio"(默认)或 "grpc"
  "nexus.grpcEndpoint": "127.0.0.1:50051",
  "nexus.model": "claude-3-5-sonnet-20241022",
  "nexus.theme": "nexus-dark"
}
```

- **stdio**(默认):扩展 spawn 一个 `nexus` 子进程,通过 stdin/stdout 通信
- **gRPC**:扩展连接到 `nexus grpc --port 50051` 启动的 server,适合多客户端共享

Nexus 提供专属主题:`Nexus Dark`、`Nexus Light`、`Nexus Midnight`。

### 18.4 Python REPL

`eval` 工具执行 Python cells,通过保留的 `python` 子进程 + NDJSON over stdio,无需 Jupyter gateway。

**Wire 协议(NDJSON)**:

Host → runner:
```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → host:`started` / `stdout` / `stderr` / `display`(MIME bundle)/ `result` / `error` / `done`。

**Magics(IPython 兼容)**:`%pip`、`%cd`、`%pwd`、`%ls`、`%env`、`%time`、`%timeit`、`%who`、`%whos`、`%reset`、`%load`、`%run`、`%%bash`、`%%sh`、`%%capture`、`%%timeit`、`%%writefile`、`!cmd`、`var = !cmd`、`var = %name args`。

**会话持久化**:`python.kernelMode`:
- `session`(默认):按 namespaced eval session id + normalized cwd + interpreter 复用 kernel
- `per-call`:每次请求新 subprocess

**agent() helper**:Prelude 提供 `agent(prompt, *, agent="task", model=None, label=None, schema=None, handle=False)`:同步调用 host bridge,跑一个 subagent,返回 final text。`schema` 提供时解析 subagent 的 JSON 输出返回 object。

### 18.5 编程式嵌入

所有 TS 包都是独立可发布的,可以在你的项目中直接 import:

```ts
import { createSandbox } from "@nexus-agent/sandbox";
import { CheckpointStore } from "@nexus-agent/checkpoint";
import { interCompaction, intraCompaction } from "@nexus-agent/compaction";
import { RoutingRegistry } from "@nexus-agent/routing";
import { startServer } from "@nexus-agent/grpc";
```

示例:自定义 Agent 嵌入沙箱:

```ts
import { createSandbox } from "@nexus-agent/sandbox";

const sandbox = await createSandbox({
  profile: "Workspace",
  workspaceRoot: process.cwd(),
  violationPolicy: "deny",
});

await sandbox.writeFile("src/foo.ts", "export const x = 1;");
const result = await sandbox.exec("ls -la");
console.log(result.stdout);
await sandbox.dispose();
```

---

## 第十九章 使用指南

### 19.1 安装

**一键安装(推荐)**:

```sh
# macOS / Linux
curl -fsSL https://nexus.agent/install | sh

# Windows(PowerShell)
irm https://nexus.agent/install.ps1 | iex
```

**通过 Bun 安装**:

```sh
bun install -g @nexus-agent/coding-agent
```

**从源码构建**:

```sh
git clone https://github.com/wjb12387767/nexus-agent.git
cd nexus-agent
bun setup      # 安装 workspace 依赖 + 构建 native addon
bun dev        # 启动 TUI
```

**前置要求**:
- Bun ≥ 1.3.14
- Rust ≥ 1.92.0(stable 工具链,**不要使用 nightly**)
- Git ≥ 2.30

**Windows 一键启动**:

```powershell
.\start.ps1            # auto-install toolchain + build + launch
.\start.ps1 -CheckOnly # only verify Bun / Rust are available
.\start.ps1 -SkipBuild # skip native module compilation
```

### 19.2 快速开始

**启动 TUI**:

```sh
nexus                 # 在当前目录启动交互式 TUI
nexus --model claude-3-5-sonnet-20241022   # 指定模型
```

TUI 启动后会读取当前目录作为工作区。所有 Agent 操作(读写文件、运行命令)默认限制在该工作区内。

**单次命令模式**:

```sh
nexus -p "把这段代码重构成 async/await 风格"
```

**配置 API Key**:

```sh
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...
```

### 19.3 配置

Nexus 的配置文件位于 `~/.nexus/`:

```
~/.nexus/
├── config.json         # 主配置
├── auth.json           # API Key(不提交到 git)
├── settings.json       # 用户偏好(TUI 主题、键位等)
└── sandbox/           # 沙箱工作区根目录
```

`config.json` 示例:

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

关键配置项:

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `model` | - | 默认模型 ID |
| `sandbox.enabled` | `true` | 是否启用沙箱 |
| `sandbox.profile` | `"Workspace"` | 沙箱策略 |
| `sandbox.violationPolicy` | `"deny"` | 沙箱违规行为 |
| `compaction.strategy` | `"nexus"` | 上下文压缩算法 |
| `compaction.threshold` | `0.8` | 触发压缩的上下文占用比例 |
| `routing.defaultModel` | - | 全局默认模型 |
| `routing.agentModels` | `{}` | 按 agent 名称指定模型 |

### 19.4 CLI 参考

**全局选项**:

```
nexus [options] [command]

Options:
  -v, --version          显示版本号
  -h, --help             显示帮助
  -m, --model <id>       指定模型(覆盖 config.json)
  -p, --prompt <text>    单次 prompt,不进 TUI
  --smoke-test           内置冒烟测试
```

**子命令**:

| 命令 | 作用 |
|---|---|
| `nexus` | 启动交互式 TUI(默认) |
| `nexus config routing` | 交互式配置 per-agent 模型路由 |
| `nexus grpc --port 50051` | 启动 gRPC server |
| `nexus grpc-cli` | gRPC 命令行客户端 |
| `nexus stats` | 显示当前会话的 token 使用统计 |
| `nexus rewind <id>` | 回滚到指定 checkpoint |
| `nexus rewind --list` | 列出所有 checkpoint |

**Slash 命令(TUI 内)**:

- `/rewind <id>` — 回滚到指定 checkpoint
- `/checkpoint` — 手动创建 checkpoint
- `/clear` — 清空当前会话上下文
- `/compact` — 手动触发上下文压缩
- `/model <id>` — 切换当前会话的模型
- `/help` — 显示所有 slash 命令
- `/skill:<name> [args]` — 调用 skill
- `/tree` — 同 session file 导航
- `/branch` — 创建新 session file 分支
- `/mcp reload` — 重载 MCP 配置
- `/mcp reconnect <name>` — 重连指定 MCP server

### 19.5 典型工作流

**工作流 1:代码重构**

```
1. cd your-project && nexus
2. 输入:"把 src/auth.ts 里的回调风格重构成 async/await"
3. Agent 会:
   - 使用 read 工具读取文件
   - 使用 ast_grep 分析 AST 结构
   - 使用 edit(hashline 模式)应用修改
   - 使用 lsp 触发 format + diagnostics
4. 如果出错,使用 /rewind 回滚到修改前
```

**工作流 2:多 Agent 协作**

```
1. 配置 ~/.nexus/config.json:
   {
     "routing": {
       "agentModels": {
         "code-reviewer": "deepseek/deepseek-coder",
         "doc-writer": "gpt-4o"
       }
     }
   }
2. 在 TUI 输入:"审查 src/auth.ts,然后生成 README"
3. Agent 会:
   - 使用 task(label="code-reviewer")派发审查子任务到 DeepSeek
   - 使用 task(label="doc-writer")派发文档生成到 GPT-4o
4. 通过 /stats 查看 token 使用
```

**工作流 3:通过 gRPC 集成**

```sh
# 终端 1:启动 gRPC server
nexus grpc --port 50051

# 终端 2:用 Python 客户端调用
python your_client.py
```

**工作流 4:使用 MCP 扩展能力**

```
1. 配置 ~/.nexus/agent/mcp.json:
   {
     "docling": {
       "command": "uvx",
       "args": ["--from=docling-mcp", "docling-mcp-server"]
     }
   }
2. 在 TUI 中输入:"读取 report.pdf 并总结"
3. Agent 会自动通过 Docling MCP 解析 PDF
```

---

## 第二十章 设计哲学与工程智慧

### 20.1 六条可教学的设计原则

在进入具体工程智慧之前,先提炼贯穿 Nexus 全局的设计原则。这六条不是事后总结,而是从代码决策中可直接反推出的工程纪律:

1. **闭环优先于单次生成** —— 没有 tool result 回环,就不是 agent,只是 completion。整个 `agentLoop` 的存在意义就是让模型生成 → 工具调用 → 观察回写 → 再生成形成闭环。

2. **策略先于副作用(Policy Before Effect)** —— Schema 校验 → 审批 → AST 分析 → 沙箱 → 执行。任何副作用发生前,必须先经过策略链。这解释了为什么 `beforeToolCall` 钩子先于 `executeToolCall`,为什么 Bash AST 分析是审批层而非执行隔离本身。

3. **有限上下文必须被治理(Managed Finite Context)** —— 默认开启 auto-compact;保留近尾上下文;支持溢出抢救。上下文不是"无限黑盒",而是需要主动会计的有限资源。

4. **控制面与数据面分离** —— steer/abort/permission/compaction 调度(控制面)与消息数据路径(数据面)解耦。这解释了为什么 `AgentSession` 不直接实现模型协议细节,为什么 `EventStream` 与 `AgentMessage[]` 分离。

5. **双语言分层** —— TypeScript 负责编排与产品逻辑;Rust/NAPI 负责性能与安全敏感路径。这不是"性能优化",而是**关注点分离**:产品逻辑频繁变化需要 TS 的灵活性;安全与性能需要 Rust 的可预测性。

6. **融合而非重写(Fusion over Rewrite)** —— 不重写 omp 已有工具实现;对 Grok/OpenClaude 做可接线的选择性移植;YAGNI 拒绝过重集群/遥测等。只移植"能力",不移植"包袱"。

### 20.2 五种融合架构模式

Nexus 把三家技术融合到同一基座时,实际使用了五种经典架构模式。识别这些模式有助于理解"怎么融合且不把系统融爆":

| 模式 | 在 Nexus 中的体现 | 教学意义 |
|---|---|---|
| **Adapter(适配器)** | gRPC server 通过适配层驱动 omp `Agent`/`AgentSession`,而不是重写一套 session | 用适配器接入已有内核,避免重写 |
| **Strategy(策略)** | compaction 多策略可切换;nexus precompact 作为前置策略插入 | 用策略族实现可插拔算法 |
| **Pipeline(管道)** | 工具执行固定管道插入 AST/sandbox 阶段 | 用管道组合横切关注点 |
| **Facade(门面)** | `nexus-sandbox` / `nexus-checkpoint` TS 门面遮蔽 NAPI/Rust 细节 | 用门面隔离跨语言复杂度 |
| **Fail-closed + Fallback** | AST 解析失败回退 regex;沙箱加载失败可降级(并应被观测) | 用失败封闭+降级链保证可用性 |

**可复用的"融合作业流程"**(若读者要做类似项目):

1. 选定基座(已有完整 agent loop + 测试的项目)
2. 列出能力缺口(安全/回滚/IDE/服务化)
3. 对每个缺口做切片移植评估(算法/接口/许可/平台)
4. 定义接入点(beforeToolCall、pre-compact、session hooks)
5. 默认保守 + 显式开关
6. 补齐破坏性测试与文档
7. 用可验证口径做对外叙事

Nexus 基本遵循该路径,这也是其工程价值的可复现部分。

### 20.3 失败闭合(Fail-Closed)

Hashline 的 recovery、seen-line guard、doom loop 的告警不阻断、compaction 的多级回退,都遵循"不确定时拒绝/告警而不是猜测"原则。`MismatchError` 总是带最新上下文返回给模型,让模型自己重读重试。

**反例对比**:传统 diff 在行号漂移时会静默错位,导致编辑落到错误位置;Hashline 立即拒绝并返回最新行号,让模型重新 ground。

### 20.4 SSoT + 派生结构

`PROVIDER_REGISTRY` 是 provider 的单一真理源,所有派生结构都从它 filter/map 生成。**添加 Provider = 一个新文件 + 一行 import + 一行数组项**。

多处使用 `satisfies` + 条件类型做编译期检查:
- `BUILTIN_API_IDS` 必须覆盖 `KnownApi`
- `PROVIDER_REGISTRY` 必须覆盖 `KnownProvider`
- `arktype` schema 推断类型必须与手写类型一致

这种设计让"遗漏"在编译期就暴露,而不是运行时。

### 20.5 Prompt Cache 友好

- append-only 上下文:消息只追加,不修改
- compaction 通过追加 `compactionSummary` 消息实现"逻辑删除"
- soft tool requirement 先 reminder 再 escalate,避免一次性破坏 cache
- asides 以非打断方式注入,不重置已发送消息
- steering/follow-up 也以追加方式注入

### 20.6 容错降级链

每个关键能力都有多级回退:

| 能力 | 降级链 |
|---|---|
| LLM 调用 | proxy V2 → V1 → 本地 |
| Compaction | nexus precompact → remote V2 → V1 → local summary → shake |
| Hashline 编辑 | tree-sitter block → 降级为 line-range → recovery → mismatch 报错 |
| FS 隔离 | Apfs/Btrfs/Zfs → LinuxReflink → Overlayfs → Rcopy |
| Token 计数 | O200k → CL100K |
| Regex | Rust regex → PCRE2 → 字面量 |

### 20.7 流式优先(Streaming-First)

几乎所有核心路径都是流式:
- `agentLoop` 返回 `EventStream<AgentEvent, AgentMessage[]>`
- `streamProxy` 走 SSE
- `streamHashLines` 是 async generator
- `parsePatchStreaming` 流式解析

这让 agent 能在 LLM 还在产出时就开始处理工具调用与边界修复,显著降低端到端延迟。

### 20.8 并发与中断分级

工具分 shared/exclusive,信号分 nonInterruptible/interruptible;pause gate 只在安全点生效,non-interruptible 工具必跑完。这种分级让 agent 既高并发又能优雅响应 steering。

### 20.9 跨平台进程身份固定

为防 PID 复用导致错误信号:
- **Linux**:`pidfd_open` + `pidfd_send_signal`(替代 `kill(pid, sig)`)
- **macOS**:`proc_bsdinfo.pbi_start_tvsec/usec` 三元组
- **Windows**:`OpenProcess` + `GetProcessTimes` creation_time
- **SpawnRegistry**:在 spawn-observer 钩子中**立即**捕获 `Process` handle,不在 cancel 时重 lookup

这是工程严谨性的体现:不信任 PID,而是用平台提供的最强身份固定机制。

### 20.10 背压与流控

- **shell.rs bridge_chunks**:`flume::bounded(64)` + `pump_chunks` 同步 `call_async` 形成背压,JS 慢时子进程被自己 pipe 阻塞而非塞进内存
- **pty.rs**:`CONTROL_MESSAGES_PER_TICK=64` + `READER_EVENTS_PER_TICK=256` 每 tick 处理上限
- **cache.rs LRU**:`MAX_CACHE_ENTRIES=16` + `evict_oldest` 防 DashMap 无界增长

### 20.11 错误恢复与 panic 隔离

- `panic = "unwind"` + `catch_unwind`,在 `task::blocking` worker 的 panic 被 catch
- `PanicDisposition::LoggedRecoverable`:在 `BLOCKING_TASK_PANIC_SCOPE_DEPTH > 0` 时,持久化报告但不 stderr
- `PanicDisposition::Fatal`:其他场景持久化 + stderr + 链 default hook(进程退出)

---

## 第二十一章 评估框架:如何客观评价 Nexus

本章提供一套可复用的评估框架,既用于本文自检,也供读者在做技术选型、写课程作业或团队评审时参考。**核心原则是显式区分三个维度**:产品综合能力(用户能用到什么)、原创工程占比(相对 omp 的增量)、默认开箱行为(配置默认值)。

### 21.1 多维评分卡

基于本文前二十章的代码审计,给出专家判断级别的评分(/10):

| 维度 | 分数 | 说明 |
|---|---:|---|
| Agent runtime 复杂度与完备性 | 9.0 | 主因 omp 基座,双层嵌套循环 + 中断分级 + Doom Loop |
| 工具深度 | 8.5 | Hashline/bash AST/LSP/eval/57 语言 AST 搜索 |
| 多模型工程 | 9.0 | 50+ Provider、14 API、5 dialect、跨进程限流、auth 重试 |
| 记忆系统 | 8.5 | Mnemopi:BeamMemory + FTS5 + Embedding + MMR + 四层缓存 |
| Checkpoint 真实性 | 8.0 | 真 CoW blob + LRU 驱逐 + 冲突检测 |
| 安全默认生产就绪 | 6.0 | 能力在,但 sandbox 默认 false,Windows 弱 |
| IDE/gRPC 成熟度 | 5.5 | gRPC 可用;VS Code 扩展工程深度弱于内核 |
| 工程测试成熟度 | 9.0 | 测试资产巨大,含破坏性回归、PTY e2e |
| Nexus 原创占比 | 3.0–3.5 | 移植/胶水为主,硬化层与融合接线为原创 |
| 品牌与发行完成度 | 5.0 | 仍可见 `@oh-my-pi/*` 残留,beta 状态 |

### 21.2 分层结论

| 评价问题 | 结论 |
|---|---|
| 作为开源 coding agent **产品能力** | **第一梯队(S-)** —— 工具/Provider/记忆/安全面广 |
| 作为**独立原创内核** | **中低(发行增强层)** —— 大量能力来自 omp/Grok/OpenClaude 移植 |
| 作为**教学与二次开发底座** | **极高** —— 分层清晰、测试充分、许可洁净 |
| 作为"默认安全的企业开箱方案" | **需加固配置** —— sandbox 默认关,Windows 平台需评估 |

### 21.3 建议的评测任务集(课程/团队可用)

1. **多文件重构**:跨 5+ 文件 API 变更,观察 Hashline 锚定成功率
2. **失败恢复**:故意引入测试失败,观察 agent 是否收敛而非死循环(Doom Loop 检测)
3. **危险命令拒绝**:构造 `rm -rf /`、`curl | sh` 等,验证 AST/审批/沙箱三道防线
4. **长会话**:>100 轮工具调用后任务是否仍连贯(Compaction 效果)
5. **溢出抢救**:人工制造 context overflow,观察 promote/compact/retry 链
6. **编辑精度**:Hashline 在大文件(>10K 行)中的定位成功率与陈旧恢复
7. **子任务隔离**:`task`/`hub` 并行是否不互相污染工作区
8. **跨平台一致性**:同 prompt 在 Linux/macOS/Windows 上的行为差异(尤其沙箱)

### 21.4 局限与风险清单

1. **非无限上下文**:压缩会丢细节;关键约束应外置到规则/记忆/文件,不能只靠窗口
2. **默认安全不足**:生产部署必须显式开启沙箱、收敛 yolo、限制工作区
3. **平台差异**:Windows 安全与 CoW 叙事需降调,生产建议 Linux/macOS
4. **供应链与许可**:三源融合带来持续合规成本,需关注上游漂移
5. **自主行动风险**:即使有审批,仍可能在授权范围内造成破坏——checkpoint 不能替代 git 备份与 CI
6. **过度叙事风险**:将发行版包装为"全自研 SOTA 内核"会误导决策与学术表述

### 21.5 决策者一页纸速查

| 场景 | 建议 |
|---|---|
| 个人/团队要强力开源编码 agent | **推荐评估试用**(优先 Linux/macOS) |
| 要二次开发行业助手 | **推荐作底座**(分层清晰、可接线) |
| 要零运维 IDE 成品替代 Cursor | **谨慎**(扩展与打磨仍 beta) |
| 要包装为全自研独家内核融资 | **不建议该叙事**(原创占比有限) |
| 要教学 agent 系统工程 | **强烈推荐作案例**(覆盖控制面/数据面/策略面) |

---

## 附录 A:术语表

| 术语 | 含义 |
|---|---|
| **ACP** | Agent Client Protocol |
| **AG-UI** | Agent GUI Protocol |
| **Anchor** | Hashline 的行锚定标签 |
| **Aside** | 非打断性插话 |
| **BPE** | Byte Pair Encoding(token 编码) |
| **Checkpoint** | 文件状态快照,用于回滚 |
| **Compaction** | 上下文压缩 |
| **ConPTY** | Windows Console Pseudo Terminal |
| **CoW** | Copy-on-Write |
| **DAP** | Debug Adapter Protocol |
| **Doom Loop** | Agent 反复调用相同工具的死循环 |
| **Follow-up** | 紧接上一轮的追加提问 |
| **Hashline** | omp 的行锚定 + 内容哈希编辑协议 |
| **ISO FS** | Projected FS,Windows 降级隔离 |
| **Landlock** | Linux 5.13+ 内核沙箱 |
| **LSP** | Language Server Protocol |
| **MCP** | Model Context Protocol |
| **MMR** | Maximal Marginal Relevance |
| **Mnemopi** | omp 的本地记忆系统 |
| **NAPI** | Node.js Native API |
| **omp** | Oh My Pi,Nexus 的基座 |
| **Pause Gate** | 进程级暂停门 |
| **Prompt Cache** | LLM 提示缓存 |
| **PTO** | Projected FS |
| **Reflink** | CoW 文件复制 |
| **Seatbelt** | macOS 沙箱机制 |
| **seccomp** | Linux syscall 过滤 |
| **Seen-line Guard** | Hashline 的盲改防护 |
| **SIXEL** | 终端图像协议 |
| **Soft Tool Requirement** | 软工具要求(可升级为强制) |
| **SSoT** | Single Source of Truth |
| **Steering** | 打断式用户插话 |
| **tree-sitter** | 增量解析库 |
| **TTSR** | Tool-Type-Specific Rules |
| **uutils** | uutils coreutils(Rust 实现) |
| **Veracity** | 记忆可信度权重 |

## 附录 B:进一步阅读

| 主题 | 文档 |
|---|---|
| 用户指南 | [docs/user-guide.md](docs/user-guide.md) |
| 集成指南 | [docs/integration-guide.md](docs/integration-guide.md) |
| 设计文档 | [DESIGN.md](DESIGN.md) |
| 路线图 | [ROADMAP.md](ROADMAP.md) |
| 变更日志 | [CHANGELOG.md](CHANGELOG.md) |
| TUI 渲染器 | [docs/tui-core-renderer.md](docs/tui-core-renderer.md) |
| 会话管理 | [docs/session.md](docs/session.md) |
| Slash 命令 | [docs/slash-command-internals.md](docs/slash-command-internals.md) |
| MCP 配置 | [docs/mcp-config.md](docs/mcp-config.md) |
| 记忆后端 | [docs/mnemosyne-memory-backend.md](docs/mnemosyne-memory-backend.md) |
| 原生 crate | [docs/native-crates.md](docs/native-crates.md) |
| 工具文档 | [docs/tools/](docs/tools) |

## 附录 C:教学大纲建议(10 课时)

若将本文作为教材使用,建议按以下节奏展开。每课时约 90 分钟,含 45 分钟讲解 + 45 分钟实验:

| 课时 | 主题 | 核心章节 | 实验内容 |
|---|---|---|---|
| 1 | Agent 与 Tool-calling 基础 | 序言 + 第一章 | 手写一个最小 agent loop(Thought → Action → Observation) |
| 2 | Nexus 分层架构走读 | 第二、三章 | 画出 L1–L5 分层图,标注每层关键包 |
| 3 | AgentSession 与中断语义 | 第四章 | 模拟 steer/IRC/pause/follow-up 四种中断 |
| 4 | 工具 schema 与 Hashline | 第五、六章 | 写一个满足严格 schema 的安全工具;Hashline 锚定实验 |
| 5 | 安全管道 | 第十章 | Bash AST 案例分析 + 沙箱开关实验(对比 deny/warn) |
| 6 | 上下文治理 | 第十二章 | 对比 prune/shake/compact 效果;手动触发 `/compact` |
| 7 | 记忆与 repo-map | 第十三章 | retain/recall 实验;观察 MMR 重排对结果多样性的影响 |
| 8 | 多模型与 dialect | 第七、八章 | 接入一个本地 Ollama 模型;观察 dialect 解析 |
| 9 | 融合方法论 | 第二十章 20.1–20.2 | 设计一个"安全插件"接入点(beforeToolCall 钩子) |
| 10 | 评测与发布 | 第二十一章 | 跑评测任务集(21.3);审计默认配置(附录 D) |

**教学要点**:第 1–4 课时建立"agent 是什么"的工程心智模型;第 5–8 课时深入各子系统;第 9–10 课时回到系统级,强调融合与评测。实验环境优先 Linux/macOS,Windows 仅用于观察沙箱降级行为。

## 附录 D:关键默认配置(上下文与安全)

下表列出影响开箱行为的关键默认值。**生产部署前必须审计此表**——部分安全相关项默认保守(false),需显式开启:

| 配置项 | 典型默认 | 含义 | 生产建议 |
|---|---|---|---|
| `compaction.enabled` | `true` | 自动上下文压缩 | 保持开启 |
| `compaction.strategy` | `snapcompact` | 默认压缩策略 | 视觉模型用 snapcompact;无视觉用 context-full |
| `compaction.keepRecentTokens` | `20000` | 近尾保留 token 数 | 长任务可上调,但注意成本 |
| `compaction.midTurnEnabled` | `true` | 工具环内检查阈值 | 保持开启,防 mid-turn 溢出 |
| `compaction.autoContinue` | `true` | 压缩后自动续跑 | 保持开启 |
| `compaction.idleEnabled` | `false` | 空闲触发压缩 | 按需开启 |
| `sandbox.enabled` | **`false`** | OS 沙箱(**需显式开启**) | **生产必须设为 `true`** |
| `sandbox.profile` | `Workspace` | 沙箱策略 | 生产用 Workspace 或 Custom |
| `sandbox.violationPolicy` | `deny` | 违规行为 | 保持 deny,warn 不推荐 |
| 审批模式 | 视配置 | always-ask / write / yolo | **生产避免 yolo** |

**生产部署清单(摘要)**:

1. **开启 sandbox**(`sandbox.enabled: true`),并选择合适 profile
2. **避免 yolo** 审批模式,至少保留 write 级审批
3. **长任务**配合大窗口模型 + 手动 `/compact` 指令保留关键约束
4. **关键结论**写入规则文件或 `retain` 到记忆,不只依赖窗口
5. **关键仓库**仍依赖 git/CI/备份,checkpoint 不能替代
6. **Windows 平台**特别注意:ISO FS 降级无法限制网络与子进程,生产建议 Linux/macOS

---

## 结语

Nexus Agent 的工程价值不在于"又造了一个 AI 编码智能体",而在于它**示范了如何把多个顶级开源项目的不可替代能力,工程化地融合到一个连贯的基座上**。这种融合不是简单代码拼凑,而是对每个能力层的深入理解、对工程边界的清醒判断、对失败模式的周密预案。

从本文的逐章节剖析可以看出,一个工业级 AI 编码智能体的内部远比"调用 LLM + 跑工具"复杂得多:它需要流式优先的架构、分级的中断语义、多层失败容忍、跨平台进程身份固定、append-only 的上下文管理、prompt cache 友好的设计、以及贯穿始终的失败闭合原则。

这些工程智慧不仅适用于 nexus-agent 本身,也适用于任何试图把 LLM 推向生产环境的系统。希望本文能成为读者理解、评估、贡献或二次开发 nexus-agent 的有用起点。

> **Nexus Agent 是独立社区项目,不隶属于 SpaceXAI、Anthropic 或任何上游项目。** "Claude" 和 "Claude Code" 是 Anthropic PBC 的商标。项目保持 MIT 开源协议,无论赞助与否。

---

*本文基于对 nexus-agent v1.0.0-beta 全部核心代码的逐文件深度阅读撰写。所有结论均直接来自对源码的阅读,未做推测性扩展。*
