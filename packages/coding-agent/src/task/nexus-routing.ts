/**
 * Task 工具与 Nexus Routing 的集成层。
 *
 * 把 `@nexus-agent/routing` 的解析逻辑包装成 task 工具可以直接调用的
 * 同步函数，内含：
 *
 * 1. **配置缓存**：进程级缓存 `loadRoutingConfigSync()` 的结果，避免每次
 *    spawn 都读盘。配置文件 mtime 变化时自动失效。
 * 2. **ModelRegistry 注册**：路由命中时调用 `registerAgentModelsInRegistry`
 *    把 agentModels 条目注册为合成 provider，让 omp 标准模型解析路径
 *    通过 `nexus-routing/<routeKey>` selector 命中。
 * 3. **错误隔离**：路由模块的任何异常都不影响 task 工具主路径，仅打 warning。
 */
import * as fs from "node:fs";
import {
	type ModelRegistryLike,
	type RoutingConfig,
	type RoutingResolution,
	loadRoutingConfigSync,
	registerAgentModelsInRegistry,
	resolveAgentRouting,
} from "@nexus-agent/routing";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * 进程级配置缓存。
 *
 * 字段：
 * - `config`：已加载的路由配置；null 表示禁用（文件缺失或校验失败）
 * - `path`：实际加载的文件路径
 * - `mtimeMs`：加载时的文件 mtime，用于检测变化
 * - `warnedInvalid`：是否已打印过校验失败 warning（避免每次 spawn 重复打）
 */
interface CachedConfig {
	config: RoutingConfig | null;
	path: string;
	mtimeMs: number;
	warnedInvalid: boolean;
}

let cachedConfig: CachedConfig | null = null;

/**
 * 同步读取配置文件 stat（mtime），用于检测变化。
 *
 * 文件不存在时返回 `null`；调用方据此决定是否重新加载。
 */
function getConfigMtime(path: string): number | null {
	try {
		return fs.statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * 获取当前生效的路由配置（带缓存）。
 *
 * - 首次调用读盘并校验
 * - 后续调用比对 mtime，变化时重读
 * - 文件缺失 / 校验失败时返回 `null`（路由功能静默禁用）
 * - 校验失败时打印一次 warning（不重复打）
 */
function getCachedConfig(): RoutingConfig | null {
	const result = loadRoutingConfigSync();
	const mtimeMs = getConfigMtime(result.path) ?? 0;

	if (cachedConfig && cachedConfig.path === result.path && cachedConfig.mtimeMs === mtimeMs) {
		return cachedConfig.config;
	}

	if (result.status === "invalid" && (!cachedConfig || !cachedConfig.warnedInvalid)) {
		logger.warn(
			`Nexus routing config invalid at ${result.path}: ${result.error ?? "unknown error"}. ` +
				`Per-agent routing is disabled until the config is fixed.`,
		);
	}

	cachedConfig = {
		config: result.config,
		path: result.path,
		mtimeMs,
		warnedInvalid: result.status === "invalid",
	};
	return result.config;
}

/**
 * 重置缓存（仅用于单测隔离）。
 */
export function resetNexusRoutingCacheForTests(): void {
	cachedConfig = null;
}

/**
 * 解析单个 subagent spawn 的路由，并在命中时把 agentModels 注册进
 * ModelRegistry。
 *
 * 返回 `RoutingResolution | null`：
 * - 命中：调用方应使用 `resolution.modelPattern` 作为 `modelOverride`
 * - 未命中（global 回落）：返回 `null`，调用方走 omp 原有解析路径
 *
 * 任何异常都被吞掉并打 warning，确保路由模块故障不影响 task 工具主路径。
 *
 * 注意：`modelRegistry` 可能为 undefined（session 尚未初始化完整）——
 * 此种情况下无法注册合成 provider，路由功能跳过。
 */
export function resolveNexusRoutingForSpawn(input: {
	modelRegistry: ModelRegistryLike | undefined;
	toolSpecifiedModel?: string;
	agentName?: string;
	subagentType?: string;
	agentDefinitionModel?: string | string[];
}): RoutingResolution | null {
	try {
		const config = getCachedConfig();
		if (!config) return null;

		// agentDefinitionModel 可能是 string[]（agent.model 支持 list），
		// 取第一个非空项作为 agentModels key 候选
		const agentDefModel = Array.isArray(input.agentDefinitionModel)
			? input.agentDefinitionModel.find(m => typeof m === "string" && m.trim()) as string | undefined
			: input.agentDefinitionModel;

		const resolution = resolveAgentRouting({
			toolSpecifiedModel: input.toolSpecifiedModel,
			agentName: input.agentName,
			subagentType: input.subagentType,
			agentDefinitionModel: agentDefModel,
			config,
		});
		if (!resolution) return null;

		// 命中：把 agentModels 注册进 ModelRegistry（幂等）
		// modelRegistry 缺失时无法注册，但 resolution 仍然返回 ——
		// 调用方拿到的 modelPattern 在没有注册的情况下解析会失败，
		// 此时回落到 omp 默认行为。这种场景仅在 session 未完全初始化时
		// 出现，正常路径不会触发。
		if (input.modelRegistry) {
			registerAgentModelsInRegistry(input.modelRegistry, config);
		}

		return resolution;
	} catch (err) {
		logger.warn(
			`Nexus routing resolution failed: ${err instanceof Error ? err.message : String(err)}. ` +
				`Falling back to omp default model resolution.`,
		);
		return null;
	}
}
