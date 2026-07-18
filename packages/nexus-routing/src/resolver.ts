/**
 * Nexus Routing — 路由解析器。
 *
 * 实现路由优先级：
 *
 *   explicit（task 工具显式指定 model，且为 agentModels key）
 *     > routing（agentRouting 按 name / subagentType 命中）
 *     > default（agentRouting.default 命中）
 *     > global（未命中，返回 null，调用方走 omp 全局 provider）
 *
 * 移植自 OpenClaude `src/services/api/agentRouting.ts`，
 * 改造点：
 * 1. 不直接操作 env vars（omp 不需要 CLAUDE_CODE_USE_OPENAI 路由切换）
 * 2. 返回 `modelPattern`（`provider/model` 形式），用于 omp 的
 *    `modelOverride` 字段，让 omp 标准模型解析路径接手
 * 3. 不内置 `resolveOutOfProcessTeammateProvider` —— omp 没有 pane/window
 *    teammate 概念，subagent 全部走 in-process subprocess，单一入口足够
 */
import {
	type AgentModelConfig,
	type AgentRouting,
	type ProviderOverride,
	type RoutingConfig,
	type RoutingResolution,
	type RoutingSource,
	NEXUS_ROUTING_PROVIDER_NAME,
} from "./types";

/**
 * 归一化 agent 标识：小写 + 去掉 `-` / `_`。
 *
 * 用于 case-insensitive、hyphen/underscore-agnostic 匹配，
 * 与 OpenClaude 行为一致。
 */
export function normalizeAgentKey(key: string): string {
	return key.toLowerCase().replace(/[-_]/g, "");
}

/**
 * 把单个 agentModels 条目转换为 ProviderOverride。
 *
 * - `model` 优先取条目内的 `model` 字段（远端实际模型名），
 *   省略时用 routeKey 本身（与 OpenClaude 一致）
 * - `base_url` / `api_key` 直接透传
 * - 条目缺失或 `api_key` 为空时返回 null（不可用）
 */
export function toProviderOverride(
	routeKey: string,
	modelConfig: AgentModelConfig | undefined,
): ProviderOverride | null {
	if (!modelConfig) return null;
	const apiKey = modelConfig.api_key.trim();
	if (!apiKey) return null;
	const baseUrl = modelConfig.base_url.trim();
	if (!baseUrl) return null;

	const override: ProviderOverride = {
		model: modelConfig.model?.trim() || routeKey,
		baseURL: baseUrl,
		apiKey,
	};
	if (modelConfig.headers && typeof modelConfig.headers === "object") {
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(modelConfig.headers)) {
			if (typeof v === "string" && v.trim()) headers[k] = v;
		}
		if (Object.keys(headers).length > 0) override.headers = headers;
	}
	return override;
}

/**
 * 构造 agentRouting 的归一化查找表。
 *
 * 同一归一化 key 出现多次时，第一次胜出（与 OpenClaude 一致），
 * 并通过 `onCollision` 回调让调用方记录 warning，避免静默 shadowing。
 */
export function buildNormalizedRouting(
	routing: AgentRouting | undefined,
	onCollision?: (key: string, normalizedKey: string) => void,
): Map<string, string> {
	const normalized = new Map<string, string>();
	if (!routing) return normalized;
	for (const [key, value] of Object.entries(routing)) {
		const nk = normalizeAgentKey(key);
		if (normalized.has(nk)) {
			onCollision?.(key, nk);
			continue;
		}
		normalized.set(nk, value);
	}
	return normalized;
}

/**
 * 按 `name > subagentType > "default"` 顺序在 agentRouting 表里查 routeKey。
 *
 * 返回 `[source, routeKey]` 或 `undefined`（未命中）。
 * `source` 区分 `routing`（name/subagentType 命中）与 `default`（兜底命中）。
 */
function matchAgentRouting(
	name: string | undefined,
	subagentType: string | undefined,
	routing: AgentRouting | undefined,
): { source: RoutingSource; routeKey: string } | undefined {
	const normalized = buildNormalizedRouting(routing);
	const candidates: Array<{ source: RoutingSource; key: string }> = [];
	if (name && name.trim()) candidates.push({ source: "routing", key: name.trim() });
	if (subagentType && subagentType.trim()) candidates.push({ source: "routing", key: subagentType.trim() });
	candidates.push({ source: "default", key: "default" });

	for (const candidate of candidates) {
		const match = normalized.get(normalizeAgentKey(candidate.key));
		if (match) {
			return { source: candidate.source, routeKey: match };
		}
	}
	return undefined;
}

/**
 * 主入口：解析单个 subagent 调用的路由。
 *
 * 优先级（与 OpenClaude `resolveAgentRunModelRouting` 一致）：
 *
 * 1. **explicit**：`toolSpecifiedModel` 非空且为 agentModels key
 *    —— task 工具显式指定了模型，绕过 agentRouting 持久配置
 * 2. **routing**：agentRouting 表按 `agentName` / `subagentType` 命中
 * 3. **default**：agentRouting.default 命中
 * 4. **global**：以上都未命中 → 返回 `null`，调用方走 omp 全局 provider
 *
 * 此外，agent 定义里的 `model` frontmatter 作为 OpenClaude 兼容的
 * 最后兜底候选：当 name/subagentType/default 都没命中时，尝试把
 * `agentDefinitionModel` 作为 agentModels key 直接命中（OpenClaude 行为）。
 */
export function resolveAgentRouting(input: {
	toolSpecifiedModel?: string;
	agentName?: string;
	subagentType?: string;
	agentDefinitionModel?: string;
	config: RoutingConfig | null | undefined;
}): RoutingResolution | null {
	const { toolSpecifiedModel, agentName, subagentType, agentDefinitionModel, config } = input;
	if (!config) return null;
	const { agentModels, agentRouting } = config;
	if (!agentModels || Object.keys(agentModels).length === 0) return null;

	// 1. explicit：task 工具显式指定了 model
	const toolRequestedModel = toolSpecifiedModel?.trim();
	if (toolRequestedModel) {
		const override = toProviderOverride(toolRequestedModel, agentModels[toolRequestedModel]);
		if (override) {
			return {
				source: "explicit",
				routeKey: toolRequestedModel,
				providerOverride: override,
				modelPattern: `${NEXUS_ROUTING_PROVIDER_NAME}/${toolRequestedModel}`,
			};
		}
		// 显式指定但不是 agentModels key —— 不回落到 agentRouting
		// （与 OpenClaude 一致：保留 getAgentModel() 的 alias/inherit 行为）
		return null;
	}

	// 2/3. routing / default
	const routingMatch = matchAgentRouting(agentName, subagentType, agentRouting);
	if (routingMatch) {
		const override = toProviderOverride(routingMatch.routeKey, agentModels[routingMatch.routeKey]);
		if (override) {
			return {
				source: routingMatch.source,
				routeKey: routingMatch.routeKey,
				providerOverride: override,
				modelPattern: `${NEXUS_ROUTING_PROVIDER_NAME}/${routingMatch.routeKey}`,
			};
		}
		// routeKey 命中但 agentModels 里没有对应条目 —— 配置错误，继续走 fallback
	}

	// 兜底：agent 定义里的 model frontmatter 作为 agentModels key 直接命中
	// （对应 OpenClaude `resolveAgentModelProvider(agentDefinitionModel, settings)`）
	if (agentDefinitionModel && agentDefinitionModel.trim()) {
		const trimmed = agentDefinitionModel.trim();
		const override = toProviderOverride(trimmed, agentModels[trimmed]);
		if (override) {
			return {
				source: "routing",
				routeKey: trimmed,
				providerOverride: override,
				modelPattern: `${NEXUS_ROUTING_PROVIDER_NAME}/${trimmed}`,
			};
		}
	}

	return null;
}

/**
 * 直接按模型名（routeKey）解析 ProviderOverride。
 *
 * 对应 OpenClaude `resolveAgentModelProvider`：精确匹配、不做 fuzzy / 大小写归一化。
 * 用于 CLI 子命令 / 配置预览场景。
 */
export function resolveAgentModelProvider(
	modelName: string | undefined,
	config: RoutingConfig | null | undefined,
): ProviderOverride | null {
	if (!config || !config.agentModels || !modelName) return null;
	const trimmed = modelName.trim();
	if (!trimmed) return null;
	return toProviderOverride(trimmed, config.agentModels[trimmed]);
}
