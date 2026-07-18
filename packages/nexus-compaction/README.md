# @nexus-agent/compaction

Nexus Agent 的**多级 compaction 引擎**，从 [Grok Build](https://github.com/) 的 `xai-grok-compaction` crate 移植而来，适配 nexus（Nexus Agent）的 `AgentMessage` / `Message` 架构。

提供**四级 compaction 算法** + **三种调度策略**，在 LLM 摘要之前先做结构化压缩，显著降低 token 占用与 LLM 调用开销。

## 四级 Compaction 算法

| 级别 | 名称 | 作用域 | 是否调 LLM | 对齐 Grok 模块 |
| ---- | ---- | ------ | ---------- | -------------- |
| 1 | `codeCompaction` | 代码块 | 否 | `code_compaction/` |
| 2 | `intraCompaction` | 单 turn 内 | 否 | `intra_compaction/` |
| 3 | `interCompaction` | 跨 turn | 否 | `inter_compaction/` + `history/filter.rs` |
| 4 | `historyCompaction` | 长期历史 | 是（可降级） | `intra_compaction/compact.rs::apply_history_compaction` + `code_compaction/summary.rs` |

### 1. code-compaction（代码块专用）

**目标**：压缩消息中过长的 fenced code block，保留可读性的同时大幅降低 token。

**算法**（对齐 Grok `format_compact_summary` 的"保留签名 + 注释占位"思路）：

1. 用正则 ``` ```lang\n...\n``` ``` 提取所有 fenced code block
2. 对行数超过 `codeBlockSize`（默认 40）的代码块：
   - 标记每行类型：`signature` / `comment` / `blank` / `body`
   - **保留所有签名行**（函数 / 类 / 接口 / 结构体声明）
   - 保留首个和末个连续注释块
   - 始终保留首 3 行 + 末 2 行
   - 连续省略区间插入 `// ... <N lines elided>` 占位

**多语言签名识别**（6 个正则覆盖）：

| 语言 | 识别的声明 |
| ---- | ---------- |
| TS / JS / Java / C / C++ | `function` / `class` / `interface` / `enum` / `struct` / `type` |
| TS / JS | `const fn = (...) => ...` 箭头函数 |
| Python | `def` / `async def` / `class` |
| Rust | `fn` / `struct` / `enum` / `impl` / `trait` / `mod` / `macro_rules!` |
| Go | `func` / `type` |
| C# | `class` / `interface` / `struct` / `enum` / `record` |

### 2. intra-compaction（单 turn 内）

**目标**：清理单条消息内部的冗余。

**三个子步骤**：

1. **`mergeDuplicateBlocks`**：同消息内重复的 text block 合并（用 FNV-1a 哈希检测完全重复，仅对超过 `intraThreshold` 的 block 生效）
2. **`collapseThinkingBlocks`**：超长 thinking 块（默认 > 8 行）保留首尾各 4 行 + 中间 `// ... <N lines elided>` 占位
3. **`mergeAdjacentDuplicateMessages`**：严格相邻且 role 相同的重复消息合并

### 3. inter-compaction（跨 turn）

**目标**：跨 turn 重复内容压缩。

**算法**（对齐 Grok `sample_compaction_chunked` + `history/filter.rs`）：

1. **过滤**（`filterTurnsForInterCompaction`）：
   - 丢弃 system / tool 消息
   - 保留 user / assistant（剥离 toolCall 内容）/ compactionSummary
2. **剥离 `<grok_user_queries>` 块**（`separatePriorUserQueries`）：历次 compaction 摘要中的 `<grok_user_queries>` 块抽出，避免 snowball
3. **跨 turn 重复检测**（`deduplicateCrossTurnContent`，nexus 扩展）：完全重复的长文本用 `[ref: duplicated from turn #N, ... chars elided]` 替代

### 4. history-compaction（长期历史摘要）

**目标**：将早期 turn 摘要为单条 `compactionSummary` 消息。

**算法**（对齐 Grok `apply_history_compaction` + `format_compact_summary`）：

1. **切分 turn**（`splitIntoTurns`）：按 user-role 消息切分
2. 若 turn 数 ≤ `historyTurns`，不处理
3. 否则：
   - 取早期 turn（除最近 `keepRecentTurns` 个）
   - 组装 `<grok_user_queries>` 前导块（含 prior summary + 当前 user queries，超长用 `truncateMiddle` 截断）
   - 调 `CompactionSampler` 生成摘要（**无 sampler 时用 `structuralFallbackSummary` 结构化裁剪**，每条消息保留首 200 字符）
   - **摘要清洗**（`formatCompactSummary`）：
     - 剥离前导 `<analysis>...</analysis>` 草稿块
     - `<summary>...</summary>` 转为 `Summary:\n{inner}` 标题
     - 中和残留控制 token（插入零宽空格，防止下轮被当作 live tag）
     - 折叠 3+ 连续空行为 2 行
   - 重组：`[system?, compactionSummary, ...recentTurns]`

## 三种调度策略

通过 `config.strategy` 字段选择：

| 策略 | 行为 | 适用场景 |
| ---- | ---- | -------- |
| `nexus` | 完全委托给 nexus 原生 compaction 函数（调用方注入） | 向后兼容，继续使用 nexus |
| `nexus` | 依次执行四级 compaction：code → intra → inter → history | 独立使用 nexus，无需 nexus |
| `hybrid` | 先 nexus 局部压缩（code/intra/inter，禁用 history），再 nexus 全局摘要 | 两者互补，最大压缩率 |

**默认策略**：`nexus`

### 不破坏 nexus API

- **不修改 nexus `packages/agent/src/compaction.ts`** 的任何已有 API
- 通过**依赖注入** `OmpCompactionFn` 接入 nexus 函数，nexus-compaction 包本身不导入 nexus
- nexus 用户可继续使用原生策略（`'context-full' | 'handoff' | 'shake' | 'snapcompact' | 'off'`），nexus 的 `'nexus' | 'nexus' | 'hybrid'` 是**另一维度**（包级策略）
- `NexusMessage` 联合类型通过**结构化类型**（structural typing）兼容 nexus `AgentMessage`，不强制依赖 nexus 包

## 安装

在 nexus-agent workspace 内已通过 catalog 注册：

```json
{
  "dependencies": {
    "@nexus-agent/compaction": "workspace:*"
  }
}
```

## 使用

### 基础用法（nexus 策略，无 LLM）

```typescript
import { compact } from "@nexus-agent/compaction";

const result = await compact(messages, {
  config: {
    strategy: "nexus",
    historyTurns: 20,
    keepRecentTurns: 4,
    codeBlockSize: 40,
  },
});

console.log(`token: ${result.tokensBefore} → ${result.tokensAfter}`);
console.log(`stages: ${JSON.stringify(result.stages)}`);
// stages: { inter: true, intra: true, code: true, history: true }
```

### 注入 LLM sampler（提升 history 摘要质量）

```typescript
import { compact, type CompactionSampler } from "@nexus-agent/compaction";

const sampler: CompactionSampler = {
  async sampleSummary(messages, systemPrompt, userPrompt, signal) {
    // 调用你的 LLM
    return await llm.chat({
      system: systemPrompt,
      user: userPrompt,
      signal,
    });
  },
};

const result = await compact(messages, {
  config: { strategy: "nexus" },
  sampler,
});
```

### hybrid 策略（nexus 局部 + nexus 全局）

```typescript
import { compact } from "@nexus-agent/compaction";
import { compact as ompCompact } from "@oh-my-pi/agent";

const result = await compact(messages, {
  config: { strategy: "hybrid", historyTurns: 20 },
  ompCompaction: async (msgs, opts) => {
    // 委托给 nexus 原生 compaction
    const prep = await prepareCompaction(msgs);
    return await ompCompact(prep, model, apiKey, opts);
  },
});
```

### nexus 策略（完全向后兼容）

```typescript
import { compact } from "@nexus-agent/compaction";

// 未注入 ompCompaction → 原样返回（passthrough）
const result = await compact(messages, {
  config: { strategy: "nexus" },
});

// 注入 ompCompaction → 委托执行
const result2 = await compact(messages, {
  config: { strategy: "nexus" },
  ompCompaction: ompFn,
});
```

## 配置参考

```typescript
interface NexusCompactionConfig {
  /** 策略 */
  strategy: "nexus" | "nexus" | "hybrid";
  /** 跨 turn 重复内容压缩阈值（字节），默认 512 */
  interThreshold: number;
  /** 单 turn 内重复 block 合并阈值（字节），默认 256 */
  intraThreshold: number;
  /** 代码块压缩触发阈值（行数），默认 40 */
  codeBlockSize: number;
  /** 历史摘要触发的 turn 数阈值，默认 20 */
  historyTurns: number;
  /** 用户消息截断字符数，默认 3000（对齐 Grok user_message_truncate_chars） */
  userMessageTruncateChars: number;
  /** 最小可压缩 token 数，默认 500（对齐 Grok min_compactable_tokens） */
  minCompactableTokens: number;
  /** 最大压缩比（after/before），默认 0.8 */
  maxReductionRatio: number;
  /** 历史摘要的最大保留最近 turn 数，默认 4 */
  keepRecentTurns: number;
}
```

默认值：

```typescript
const DEFAULT_NEXUS_CONFIG = {
  strategy: "nexus",
  interThreshold: 512,
  intraThreshold: 256,
  codeBlockSize: 40,
  historyTurns: 20,
  userMessageTruncateChars: 3000,
  minCompactableTokens: 500,
  maxReductionRatio: 0.8,
  keepRecentTurns: 4,
};
```

## 与 nexus 的关系

| 维度 | nexus `@oh-my-pi/agent` | nexus `@nexus-agent/compaction` |
| ---- | --------------------- | ------------------------------- |
| compaction 策略字段 | `CompactionSettings.strategy: 'context-full' \| 'handoff' \| 'shake' \| 'snapcompact' \| 'off'` | `NexusCompactionConfig.strategy: 'nexus' \| 'nexus' \| 'hybrid'` |
| 算法层级 | 单级（LLM 摘要） | 四级（code / intra / inter / history） |
| LLM 依赖 | 必需 | 可选（无 sampler 时用结构化裁剪） |
| 代码块处理 | 无 | 保留签名 + 占位 |
| 跨 turn 去重 | 无 | `[ref:]` 替代 |
| 消息类型 | `AgentMessage` | `NexusMessage`（结构兼容 `AgentMessage`） |
| 集成方式 | nexus 内置 | 依赖注入 `OmpCompactionFn` |

**兼容性**：`NexusMessage` 联合类型包含一个兜底分支 `{ role: string; content?: unknown; timestamp?: number }`，结构兼容 nexus 的 `AgentMessage = Message | CustomAgentMessages[...]`。无需强制依赖 nexus 包即可独立测试。

## 基准测试

测试文件：`test/benchmark.test.ts`

**会话构造**（模拟真实 agent 会话）：
- 1 条 system prompt（长，含项目上下文）
- 100 组 user + assistant turn：
  - user: 含重复的项目上下文 + 具体问题
  - assistant: 含 15 行 thinking 块 + 50 行代码块

**测试场景**：

| 场景 | 策略 | LLM | 断言 |
| ---- | ---- | --- | ---- |
| 1 | nexus | 无（结构化裁剪） | token 节省 ≥ 20% |
| 2 | nexus | mock sampler | token 节省 ≥ 20% |
| 3 | hybrid | mock nexus | token 节省 ≥ 20% |
| 4 | nexus | 无 | 各级 stage 均有贡献 |
| 5 | nexus | 无 | 压缩后消息结构完整 |

**预期结果**：

- 100-turn 会话：token 节省 **≥ 80%**（主要由 history compaction 贡献，97 个早期 turn 摘要为单条消息）
- 50-turn 会话：token 节省 ≥ 20%
- 200-turn 会话：token 节省 ≥ 30%

运行测试：

```bash
cd packages/nexus-compaction
bun test benchmark.test.ts
```

## 开发

```bash
# 类型检查
bun run check:types

# Lint
bun run lint

# 运行全部测试
bun test

# 运行特定测试
bun test inter-compaction.test.ts
```

## 模块结构

```
packages/nexus-compaction/
├── src/
│   ├── index.ts              # Public API 导出
│   ├── types.ts              # 类型定义（NexusMessage / Config / Result / CompactionItem）
│   ├── tokenizer.ts          # 轻量 token 估算器（ASCII 4 char/token，CJK 2 char/token）
│   ├── inter-compaction.ts   # 跨 turn 压缩
│   ├── intra-compaction.ts   # 单 turn 内压缩
│   ├── code-compaction.ts    # 代码块专用压缩
│   ├── history-compaction.ts # 长期历史摘要
│   ├── select.ts             # 尾部保留选择器（对齐 Grok select_turns_to_compact）
│   ├── prompts.ts            # Prompt 模板（对齐 Grok prompt 文本）
│   └── strategy.ts           # 策略调度器（nexus/nexus/hybrid）
├── test/
│   ├── inter-compaction.test.ts
│   ├── intra-compaction.test.ts
│   ├── code-compaction.test.ts
│   ├── strategy.test.ts
│   └── benchmark.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 许可证

MIT
