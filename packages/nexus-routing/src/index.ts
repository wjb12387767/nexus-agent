/**
 * @nexus-agent/routing — per-agent 模型路由
 *
 * 从 OpenClaude 的 `agentModels` / `agentRouting` 设计移植，适配 Nexus Agent
 * 的 ModelRegistry 架构。
 *
 * ## 公共 API
 *
 * ### 类型（types.ts）
 * - `RoutingConfig`：顶层路由配置
 * - `AgentModels` / `AgentRouting`：两张配置表
 * - `AgentModelConfig`：单条 agentModels 条目
 * - `ProviderOverride`：路由命中后构造的 Provider 覆盖项
 * - `RoutingResolution`：路由解析结果
 * - `RoutingSource`：命中来源（explicit / routing / default）
 *
 * ### 解析（resolver.ts）
 * - `resolveAgentRouting(input)`：主入口，返回 `RoutingResolution | null`
 * - `resolveAgentModelProvider(modelName, config)`：按模型名直接查
 * - `normalizeAgentKey(key)`：归一化（测试 / 调试用）
 * - `toProviderOverride(routeKey, modelConfig)`：单条转换
 *
 * ### 配置加载（config-loader.ts）
 * - `loadRoutingConfig(path?)`：异步加载（推荐）
 * - `loadRoutingConfigSync(path?)`：同步加载（hot path 用）
 * - `saveRoutingConfig(config, path?)`：保存
 * - `resolveConfigPath()`：解析实际配置路径
 * - `getDefaultConfigPath()`：默认路径 `~/.nexus/config.json`
 *
 * ### Schema 校验（schema.ts）
 * - `validateRoutingConfig(input)`：校验并归一化
 * - `RoutingConfigValidationError`：校验错误类型
 *
 * ### ModelRegistry 桥接（registry-bridge.ts）
 * - `registerAgentModelsInRegistry(modelRegistry, config)`：注册合成 provider
 * - `ModelRegistryLike`：最小接口（避免循环依赖）
 * - `NEXUS_ROUTING_PROVIDER_NAME`：合成 provider 名 `"nexus-routing"`
 * - `NEXUS_ROUTING_SOURCE_ID`：sourceId `"nexus-routing"`
 */

// 类型
export type {
	AgentModelConfig,
	AgentModels,
	AgentRouting,
	ProviderOverride,
	RoutingConfig,
	RoutingResolution,
	RoutingResolutionInput,
	RoutingSource,
} from "./types";

export {
	NEXUS_ROUTING_PROVIDER_NAME,
} from "./types";

// 解析器
export {
	buildNormalizedRouting,
	normalizeAgentKey,
	resolveAgentModelProvider,
	resolveAgentRouting,
	toProviderOverride,
} from "./resolver";

// Schema
export {
	RoutingConfigSchema,
	AgentModelsSchema,
	AgentRoutingSchema,
	validateRoutingConfig,
	RoutingConfigValidationError,
} from "./schema";
export type { SchemaRoutingConfig } from "./schema";

// 配置加载
export {
	getDefaultConfigPath,
	loadRoutingConfig,
	loadRoutingConfigSync,
	resolveConfigPath,
	saveRoutingConfig,
	serializeRoutingConfig,
	NEXUS_ROUTING_CONFIG_ENV,
	NEXUS_CONFIG_DIR,
	NEXUS_CONFIG_FILENAME,
} from "./config-loader";
export type { LoadResult } from "./config-loader";

// ModelRegistry 桥接
export {
	buildProviderConfigInput,
	registerAgentModelsInRegistry,
	resetBridgeStateForTests,
	unregisterAgentModelsFromRegistry,
	NEXUS_ROUTING_SOURCE_ID,
} from "./registry-bridge";
export type {
	ModelRegistryLike,
	ProviderConfigInputLike,
} from "./registry-bridge";
