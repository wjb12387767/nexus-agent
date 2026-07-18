/**
 * Nexus Routing — omp ModelRegistry 桥接层。
 *
 * 把 agentModels 条目注册成 omp `ModelRegistry` 中的合成 provider +
 * 合成模型，让 omp 标准模型解析路径（`resolveModelOverride` /
 * `parseModelPattern`）能通过 `nexus-routing/<routeKey>` selector 命中。
 *
 * 设计要点：
 *
 * 1. **不直接 import omp 的 ModelRegistry 类**：nexus-routing 包不能依赖
 *    `@oh-my-pi/pi-coding-agent`（会形成循环依赖）。这里只定义一个最小
 *    `ModelRegistryLike` 接口，由调用方（task 工具）传入真实实例。
 * 2. **单次注册全部 agentModels 条目**：omp `registerProvider` 多次调用
 *    同一 provider 名会替换该 provider 下所有模型，因此 bridge 在一次调用
 *    里把所有 routeKey 都作为模型注册进去。
 * 3. **幂等**：通过 `sourceId` + config 指纹缓存避免重复注册。
 * 4. **OpenAI 兼容**：agentModels 条目都是 OpenAI 兼容端点（与 OpenClaude
 *    一致），因此 `api` 固定为 `"openai-completions"`。
 */
import type { RoutingConfig } from "./types";
import { NEXUS_ROUTING_PROVIDER_NAME } from "./types";

/**
 * omp `ModelRegistry` 的最小子集接口。
 *
 * 真实类型见 `packages/coding-agent/src/config/model-registry.ts` 的
 * `ModelRegistry.registerProvider(providerName, config, sourceId)`。
 * 这里抽出必要字段，避免循环依赖。
 */
export interface ModelRegistryLike {
	registerProvider(
		providerName: string,
		config: ProviderConfigInputLike,
		sourceId?: string,
	): void;
}

/**
 * omp `ProviderConfigInput` 的最小子集（与 omp `ModelRegistry.registerProvider`
 * 入参形状兼容）。完整定义见
 * `packages/coding-agent/src/config/model-registry.ts`。
 */
export interface ProviderConfigInputLike {
	baseUrl?: string;
	apiKey?: string;
	/** OpenAI 兼容端点固定为 "openai-completions" */
	api?: string;
	headers?: Record<string, string>;
	models: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		supportsTools?: boolean;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	}>;
}

/** bridge 用的 sourceId，用于 omp ModelRegistry 的来源追踪与注销 */
export const NEXUS_ROUTING_SOURCE_ID = "nexus-routing";

/** agentModels 条目都是 OpenAI 兼容端点 */
const NEXUS_ROUTING_API = "openai-completions";

/**
 * 默认模型规格（OpenAI 兼容端点的合理默认值）。
 *
 * agentModels 配置不包含 token / cost 等元数据，bridge 用以下默认值
 * 填充 omp ModelDefinition 必填字段。这些值会影响 omp 的 token 计数
 * 与 cost 显示，但不影响实际 API 调用（OpenAI 兼容端点按真实响应计费）。
 */
const DEFAULT_MODEL_SPEC = {
	reasoning: false,
	input: ["text" as const, "image" as const],
	supportsTools: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

/**
 * 已注册配置的指纹缓存：sourceId → 序列化指纹。
 *
 * 同一 process 内，相同 config 重复调用 `registerAgentModelsInRegistry`
 * 直接跳过，避免 omp `registerProvider` 的清空-重建循环。
 */
const registeredFingerprints = new Map<string, string>();

/**
 * 计算一份 RoutingConfig 的指纹（用于幂等判断）。
 *
 * 仅 hash agentModels 部分（agentRouting 不影响注册的合成模型集合）。
 * 用 `JSON.stringify` 是 O(n) 的，对几十个条目足够快；如果将来需要更高
 * 性能可以换成结构化 hash。
 */
function configFingerprint(config: RoutingConfig): string {
	if (!config.agentModels) return "{}";
	return JSON.stringify(config.agentModels);
}

/**
 * 构造 omp `registerProvider` 入参（一个合成 provider，所有 routeKey 作为模型）。
 *
 * 单次调用注册所有 agentModels 条目，避免 `registerProvider` 多次调用
 * 同名 provider 时的清空-重建行为。
 */
export function buildProviderConfigInput(config: RoutingConfig): ProviderConfigInputLike | null {
	if (!config.agentModels || Object.keys(config.agentModels).length === 0) return null;

	const models: ProviderConfigInputLike["models"] = [];
	let sharedBaseUrl: string | undefined;
	let sharedApiKey: string | undefined;
	const sharedHeaders: Record<string, string> = {};

	for (const [routeKey, modelConfig] of Object.entries(config.agentModels)) {
		const apiKey = modelConfig.api_key.trim();
		const baseUrl = modelConfig.base_url.trim();
		if (!apiKey || !baseUrl) continue;

		// 所有条目共享 provider 级 baseUrl/apiKey；omp 单个 model 也可覆盖。
		// 这里把第一个有效条目的 baseUrl/apiKey 作为 provider 级共享。
		sharedBaseUrl ??= baseUrl;
		sharedApiKey ??= apiKey;

		// 合并 headers（不冲突时累加）
		if (modelConfig.headers) {
			for (const [k, v] of Object.entries(modelConfig.headers)) {
				if (typeof v === "string" && v.trim() && !(k in sharedHeaders)) {
					sharedHeaders[k] = v;
				}
			}
		}

		models.push({
			id: routeKey,
			name: routeKey,
			reasoning: DEFAULT_MODEL_SPEC.reasoning,
			input: [...DEFAULT_MODEL_SPEC.input],
			supportsTools: DEFAULT_MODEL_SPEC.supportsTools,
			cost: { ...DEFAULT_MODEL_SPEC.cost },
			contextWindow: DEFAULT_MODEL_SPEC.contextWindow,
			maxTokens: DEFAULT_MODEL_SPEC.maxTokens,
		});
	}

	if (models.length === 0 || !sharedBaseUrl || !sharedApiKey) return null;

	const input: ProviderConfigInputLike = {
		baseUrl: sharedBaseUrl,
		apiKey: sharedApiKey,
		api: NEXUS_ROUTING_API,
		models,
	};
	if (Object.keys(sharedHeaders).length > 0) input.headers = sharedHeaders;
	return input;
}

/**
 * 把 RoutingConfig 里的 agentModels 注册进 omp ModelRegistry。
 *
 * 幂等：相同 config 指纹重复调用直接返回 `false`（已注册过）。
 * 返回 `true` 表示本次调用实际执行了注册。
 *
 * 注意：每个 agentModels 条目共享同一个 provider 名（`nexus-routing`），
 * 每个条目作为该 provider 下的一个 model（id = routeKey）。如果不同
 * 条目用不同的 baseUrl/apiKey，bridge 会用第一个有效条目的值作为
 * provider 级共享，其他条目的差异被忽略 —— 这是 omp `registerProvider`
 * API 的限制（单 provider 单 baseUrl/apiKey）。
 *
 * 对绝大多数实际配置（所有 agentModels 条目共用一对凭据 + 不同 model 名）
 * 这就够了；如果需要 per-route 凭据，可以把每个 routeKey 注册为独立的
 * provider（`nexus-routing-<routeKey>`），代价是 selector 变长。当前实现
 * 与 OpenClaude 行为对齐（OpenClaude 也是 OpenAI 兼容 + 共享凭据）。
 */
export function registerAgentModelsInRegistry(
	modelRegistry: ModelRegistryLike,
	config: RoutingConfig,
): boolean {
	const providerConfig = buildProviderConfigInput(config);
	if (!providerConfig) return false;

	const fingerprint = configFingerprint(config);
	if (registeredFingerprints.get(NEXUS_ROUTING_SOURCE_ID) === fingerprint) {
		return false;
	}

	modelRegistry.registerProvider(NEXUS_ROUTING_PROVIDER_NAME, providerConfig, NEXUS_ROUTING_SOURCE_ID);
	registeredFingerprints.set(NEXUS_ROUTING_SOURCE_ID, fingerprint);
	return true;
}

/**
 * 注销所有已注册的 nexus-routing 合成 provider。
 *
 * 用于测试隔离或配置热重载场景。
 */
export function unregisterAgentModelsFromRegistry(modelRegistry: {
	unregisterProvider?: (sourceId: string) => void;
}): void {
	registeredFingerprints.delete(NEXUS_ROUTING_SOURCE_ID);
	// omp ModelRegistry 没有 public unregister API；这里仅清本地缓存。
	// 如果上层 ModelRegistry 实现了 `unregisterProvider(sourceId)`，调用它。
	modelRegistry.unregisterProvider?.(NEXUS_ROUTING_SOURCE_ID);
}

/**
 * 重置 bridge 的内部状态（仅用于单测隔离）。
 *
 * 不影响已注册进真实 ModelRegistry 的合成 provider。
 */
export function resetBridgeStateForTests(): void {
	registeredFingerprints.clear();
}
