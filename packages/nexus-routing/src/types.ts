/**
 * Nexus Agent — per-agent 模型路由类型定义
 *
 * 从 OpenClaude 的 `agentModels` / `agentRouting` 配置模型移植而来，
 * 适配 Nexus Agent 的 ModelRegistry 架构。
 *
 * 配置形态（参考 `~/.nexus/config.json`）：
 *
 * ```json
 * {
 *   "agentModels": {
 *     "deepseek-v4-flash": {
 *       "base_url": "https://api.deepseek.com/v1",
 *       "api_key": "sk-..."
 *     },
 *     "zai-default": {
 *       "model": "glm-5.1",
 *       "base_url": "https://api.z.ai/api/coding/paas/v4",
 *       "api_key": "sk-..."
 *     }
 *   },
 *   "agentRouting": {
 *     "Explore": "deepseek-v4-flash",
 *     "Plan": "gpt-4o",
 *     "default": "gpt-4o"
 *   }
 * }
 * ```
 *
 * 路由命中后，agentModels 条目作为 OpenAI 兼容的 ProviderOverride 注入
 * omp 的 ModelRegistry；subagent 通过 `modelOverride` 走标准模型解析路径。
 */

/**
 * 单个 agentModels 条目：OpenAI 兼容的端点 + 凭据。
 *
 * - `base_url`：OpenAI 兼容的 API 入口
 * - `api_key`：明文 API key（与 OpenClaude 一致；由用户自己保证文件权限）
 * - `model`：可选；当路由 key 与实际模型名不同时使用。
 *   例如 key 为 `zai-default` 但实际模型为 `glm-5.1`。
 *   省略时，路由 key 本身作为模型名。
 */
export interface AgentModelConfig {
	model?: string;
	base_url: string;
	api_key: string;
	/** 可选额外 headers（如 `Authorization: Bearer ...` 之外的自定义头） */
	headers?: Record<string, string>;
}

/**
 * agentModels 表：路由 key → Provider 配置。
 *
 * key 通常是简短的本地别名（`deepseek-v4-flash` / `zai-default`），
 * 不一定是真实模型 id；当需要本地别名 → 远端模型名映射时，
 * 在条目内设置 `model` 字段。
 */
export type AgentModels = Record<string, AgentModelConfig>;

/**
 * agentRouting 表：agent 标识 → agentModels key。
 *
 * agent 标识按以下顺序解析（normalize 后大小写、`-`/`_` 不敏感）：
 *
 * 1. task 工具显式指定的 `model`（最高优先级）
 * 2. agent 名称（如 "Explore" / "Plan"）
 * 3. subagent 类型（如 "general-purpose" / "frontend-dev"）
 * 4. `"default"` 兜底
 *
 * 未命中任何条目时，回落到 omp 全局 provider（parent session 的 active model）。
 */
export type AgentRouting = Record<string, string>;

/**
 * 顶层路由配置：从 `~/.nexus/config.json` 加载。
 */
export interface RoutingConfig {
	agentModels?: AgentModels;
	agentRouting?: AgentRouting;
}

/**
 * 路由命中后构造的 Provider 覆盖项。
 *
 * 等价于 OpenClaude 的 `ProviderOverride`：
 * 当 subagent 命中路由时，使用这些值取代全局 env vars 调用 API。
 */
export interface ProviderOverride {
	/** 实际发送给 API 的模型名（来自 `agentModels.<key>.model` 或 key 本身） */
	model: string;
	/** OpenAI 兼容 base URL */
	baseURL: string;
	/** API key */
	apiKey: string;
	/** 可选额外 headers */
	headers?: Record<string, string>;
}

/**
 * 路由命中的来源标识，用于 telemetry / 日志。
 *
 * 优先级（从高到低）：
 * - `explicit`：task 工具显式指定了 model，且该 model 是 agentModels key
 * - `routing`：agentRouting 表按 name/subagentType 命中
 * - `default`：agentRouting.default 命中
 * - `global`：未命中任何条目，回落到 omp 全局 provider（resolution 为 null）
 */
export type RoutingSource = "explicit" | "routing" | "default";

/**
 * 路由解析结果。
 *
 * - 命中时：包含 `source`、`routeKey`（命中的 agentModels key）、
 *   `providerOverride`（构造的 ProviderOverride）、`modelPattern`（用于
 *   omp `modelOverride` 字段的 `provider/model` 选择器，会被注册进
 *   ModelRegistry 作为合成模型）。
 * - 未命中（global 回落）：返回 `null`，调用方走原有逻辑。
 */
export interface RoutingResolution {
	source: RoutingSource;
	/** 命中的 agentModels key（如 "deepseek-v4-flash"） */
	routeKey: string;
	/** 构造出的 ProviderOverride，可注入 ModelRegistry */
	providerOverride: ProviderOverride;
	/**
	 * `provider/model` 形式的选择器，用于 omp 的 `modelOverride` 字段。
	 *
	 * 格式：`<bridgeProviderName>/<routeKey>`，其中 bridgeProviderName
	 * 由 registry-bridge 模块决定（通常为 `nexus-routing`）。
	 * registry-bridge 会把 routeKey 对应的 AgentModelConfig 注册为
	 * 该 provider 下的一个合成模型，使 omp 的 `resolveModelOverride`
	 * 能通过该 selector 命中。
	 */
	modelPattern: string;
}

/**
 * 路由解析入参。
 *
 * 镜像 OpenClaude `resolveAgentRunModelRouting` 的入参集合，
 * 但去掉 OpenClaude 特有的 `resolvedAgentModel`（omp 没有这个概念）。
 */
export interface RoutingResolutionInput {
	/** task 工具显式指定的 model（最高优先级） */
	toolSpecifiedModel?: string;
	/** subagent 名称（如 "Explore"） */
	agentName?: string;
	/** subagent 类型（如 "general-purpose"） */
	subagentType?: string;
	/** agent 定义里的 `model` frontmatter（兜底候选） */
	agentDefinitionModel?: string;
	/** 已加载的路由配置；为 null/undefined 时直接返回 null */
	config: RoutingConfig | null | undefined;
}

/**
 * registry-bridge 注册时使用的合成 provider 名。
 *
 * 所有 agentModels 条目都会作为该 provider 下的合成模型注册进 omp
 * ModelRegistry，使 omp 的模型解析路径（`resolveModelOverride` /
 * `parseModelPattern`）能通过 `nexus-routing/<routeKey>` 命中。
 */
export const NEXUS_ROUTING_PROVIDER_NAME = "nexus-routing";
