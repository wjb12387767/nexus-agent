# @nexus-agent/routing

Nexus Agent 的 **per-agent 模型路由**，从 [OpenClaude](https://github.com/) 的 `agentModels` / `agentRouting` 设计移植而来，适配 nexus（Nexus Agent）的 `ModelRegistry` 架构。

让不同的 subagent（如 `Explore`、`Plan`、`Code Reviewer`）走不同的 OpenAI 兼容端点 + 模型，而不是全部回落到 parent session 的全局 provider。

## 路由优先级

```
explicit   >   routing   >   default   >   global
```

| 优先级 | 来源           | 命中条件                                                              |
| ------ | -------------- | --------------------------------------------------------------------- |
| 1      | `explicit`     | `task` 工具显式指定 `--model <key>`，且 `<key>` 存在于 `agentModels`  |
| 2      | `routing`      | `agentRouting` 表按 agent `name` / `subagentType` 命中                 |
| 3      | `default`      | `agentRouting["default"]` 命中                                        |
| 4      | `global`       | 以上都未命中，回落到 nexus parent session 的 active model（resolution=null） |

agent 标识匹配是 **大小写、`-`/`_` 不敏感** 的（normalize 后比较），与 OpenClaude 行为一致。例如 `agentRouting["explore"]` 能命中名为 `Explore` 的 agent。

## 配置文件

**路径**：`~/.nexus/config.json`（Windows: `%USERPROFILE%\.nexus\config.json`）

**环境变量覆盖**：`NEXUS_ROUTING_CONFIG=<path>`（测试 / CI 用）

**Schema**：

```json
{
  "agentModels": {
    "deepseek-v4-flash": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-..."
    },
    "zai-glm": {
      "model": "glm-5.1",
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "sk-...",
      "headers": {
        "X-Custom-Header": "value"
      }
    }
  },
  "agentRouting": {
    "Explore": "deepseek-v4-flash",
    "Plan": "zai-glm",
    "default": "deepseek-v4-flash"
  }
}
```

### 字段说明

**`agentModels`** —— 路由 key → OpenAI 兼容 Provider 配置：

| 字段       | 类型                     | 必填 | 说明                                                                 |
| ---------- | ------------------------ | ---- | -------------------------------------------------------------------- |
| `base_url` | string                   | ✓    | OpenAI 兼容 API 入口                                                 |
| `api_key`  | string                   | ✓    | 明文 API key（用户自己保证文件权限）                                 |
| `model`    | string                   |      | 实际模型名；省略时用 routeKey 本身（用于本地别名 → 远端模型名映射）  |
| `headers`  | Record\<string, string\> |      | 额外 headers（如自定义认证头）                                       |

**`agentRouting`** —— agent 标识 → `agentModels` key：

| key                | 说明                                                   |
| ------------------ | ------------------------------------------------------ |
| `<agentName>`      | task 工具 spawn 时传入的 agent 名（如 `Explore`）      |
| `<subagentType>`   | subagent 类型（如 `general-purpose`）                  |
| `default`          | 兜底路由，所有未命中的 agent 都走这条                  |

> **注意**：`agentRouting` 引用的 key 必须存在于 `agentModels`，否则该路由条目被忽略（CLI list 时标 `✗`）。

## CLI 用法

入口：`nexus config routing <subcommand> [args] [--flags]`

```bash
# 查看当前配置
nexus config routing list
nexus config routing list --json

# 配置文件路径
nexus config routing path

# 创建空配置文件
nexus config routing init

# 添加 agentModels 条目（缺失参数交互式询问）
nexus config routing add-model deepseek-v4-flash https://api.deepseek.com/v1 sk-xxx
nexus config routing add-model zai-glm https://api.z.ai/v1 sk-xxx --model glm-5.1 --header X-Org:my-org

# 删除 agentModels 条目（连带清理引用它的 agentRouting）
nexus config routing remove-model deepseek-v4-flash

# 添加 / 删除 agentRouting 条目
nexus config routing add-route Explore deepseek-v4-flash
nexus config routing add-route default deepseek-v4-flash
nexus config routing remove-route Explore

# 清空全部配置（交互式确认）
nexus config routing reset

# 帮助
nexus config routing help
```

### Flags

| Flag             | 适用子命令     | 说明                                          |
| ---------------- | -------------- | --------------------------------------------- |
| `--json`         | `list` / `show` | 输出 JSON                                     |
| `--model <name>` | `add-model`    | 实际模型名（默认等于 routeKey）               |
| `--header K:V`   | `add-model`    | 额外 header，可重复                           |
| `--help` / `-h`  | 全部           | 打印帮助                                      |

## 程序化 API

```typescript
import {
  resolveAgentRouting,
  loadRoutingConfigSync,
  registerAgentModelsInRegistry,
  type RoutingResolution,
} from "@nexus-agent/routing";

// 1. 加载配置（同步，hot path 用）
const result = loadRoutingConfigSync();
// result.config: RoutingConfig | null
// result.status: "loaded" | "missing" | "invalid" | "empty"

// 2. 解析路由
const resolution: RoutingResolution | null = resolveAgentRouting({
  toolSpecifiedModel: undefined,   // task 工具显式指定的 model（最高优先级）
  agentName: "Explore",            // subagent 名称
  subagentType: "Explore",         // subagent 类型
  agentDefinitionModel: undefined, // agent 定义里的 model frontmatter（兜底候选）
  config: result.config,
});

if (resolution) {
  console.log(resolution.source);        // "explicit" | "routing" | "default"
  console.log(resolution.routeKey);      // 命中的 agentModels key
  console.log(resolution.modelPattern);  // "nexus-routing/<routeKey>"，用于 nexus modelOverride
  console.log(resolution.providerOverride);
  // { model: "...", baseURL: "...", apiKey: "...", headers?: {...} }

  // 3. 注册合成 provider 到 nexus ModelRegistry（幂等）
  registerAgentModelsInRegistry(modelRegistry, result.config);
  // 之后 task 工具用 resolution.modelPattern 作为 modelOverride 即可命中
} else {
  // 未命中，走 nexus 全局 provider
}
```

### 路由解析细节

`resolveAgentRouting` 内部按以下顺序匹配（参考 `src/resolver.ts`）：

```
1. toolSpecifiedModel 命中 agentModels[toolSpecifiedModel]?
   → source = "explicit"

2. agentRouting[normalize(agentName)] 命中?
   → source = "routing"
   agentRouting[normalize(subagentType)] 命中?
   → source = "routing"

3. agentRouting[normalize("default")] 命中?
   → source = "default"

4. agentDefinitionModel 作为 agentModels key 直接命中?
   → source = "routing"（OpenClaude 兼容兜底）

5. 都未命中 → 返回 null（调用方走 global）
```

normalize 规则：`key.toLowerCase().replace(/[-_]/g, "")`

## 集成到 task 工具

`packages/coding-agent/src/task/nexus-routing.ts` 是 task 工具的集成层：

```typescript
import { resolveNexusRoutingForSpawn } from "./nexus-routing";

const resolution = resolveNexusRoutingForSpawn({
  modelRegistry: session.modelRegistry,
  toolSpecifiedModel: undefined,
  agentName,
  subagentType: agentName,
  agentDefinitionModel: effectiveAgent.model,
});

const modelOverride = resolution
  ? [resolution.modelPattern]              // 命中：走合成 provider
  : resolveAgentModelPatterns({ ... });    // 未命中：走 nexus 原有解析
```

特性：
- **配置缓存**：进程级缓存 + mtime 检测，避免每次 spawn 读盘
- **错误隔离**：路由模块任何异常都不影响 task 主路径，仅打 warning
- **幂等注册**：通过 config 指纹缓存避免重复调用 `registerProvider`

## 与 OpenClaude 的差异

| 维度         | OpenClaude                          | Nexus                                              |
| ------------ | ----------------------------------- | -------------------------------------------------- |
| 配置文件     | `~/.openclaude.json` 内联           | `~/.nexus/config.json` 独立（避免与 nexus settings 冲突） |
| Provider 架构 | 自管 Provider 实例                  | 桥接 nexus `ModelRegistry`，注册为合成 provider      |
| 环境变量     | `CLAUDE_CODE_USE_OPENAI` 切换       | 无（路由命中即用，未命中即回落 nexus 全局）           |
| teammate     | `resolveOutOfProcessTeammateProvider` | 无（nexus subagent 全部 in-process）                |
| API 风格     | env var 注入                        | `modelOverride` selector（`nexus-routing/<key>`）  |

## 模块结构

```
packages/nexus-routing/
├── src/
│   ├── index.ts            # 公共 API 出口
│   ├── types.ts            # RoutingConfig / RoutingResolution / ProviderOverride 等
│   ├── schema.ts           # arktype schema + validateRoutingConfig
│   ├── resolver.ts         # resolveAgentRouting（核心解析器）
│   ├── registry-bridge.ts  # nexus ModelRegistry 桥接（registerAgentModelsInRegistry）
│   └── config-loader.ts    # ~/.nexus/config.json 加载 / 保存
├── test/
│   └── resolver.test.ts    # 单测（覆盖优先级、归一化、bridge 幂等）
├── package.json
└── tsconfig.json
```

## 测试

```bash
cd packages/nexus-routing
bun test
```

测试覆盖（见 `test/resolver.test.ts`）：
- `normalizeAgentKey` / `toProviderOverride` / `buildNormalizedRouting`
- 优先级：explicit > routing > default > global
- 归一化匹配（`Explore` = `explore` = `ex-plore`）
- routeKey 命中但 agentModels 缺失 → 走 fallback
- agentDefinitionModel 兜底
- `resolveAgentModelProvider` 精确匹配
- `validateRoutingConfig` 校验与归一化
- `registerAgentModelsInRegistry` 幂等性

## 安全提示

- `~/.nexus/config.json` 含明文 API key —— 用户自己保证文件权限（`chmod 600`）
- 路由配置独立于 nexus settings，不影响全局 provider
- 路由模块故障不影响 task 工具主路径（错误隔离）

## 来源

- OpenClaude `src/services/api/agentRouting.ts`（MIT）
- nexus `packages/coding-agent/src/config/model-registry.ts`（MIT）
