/**
 * Nexus Routing — 配置 schema 验证。
 *
 * 使用 arktype（与 omp `models-config-schema.ts` 一致）。
 * 为降低启动开销，schema 用 `scope({}, { jitless: true })` 关闭 JIT
 * codegen，校验正确性不受影响。
 */
import { scope } from "arktype";
import type { AgentModelConfig, AgentModels, AgentRouting, RoutingConfig } from "./types";

const { type } = scope({}, { jitless: true });

/**
 * 单个 agentModels 条目 schema。
 *
 * - `base_url`、`api_key` 必填且非空（trim 后）
 * - `model`、`headers` 可选
 *
 * 注意：arktype 的 `string` 类型允许空串，因此在 `.narrow` 里
 * 显式校验 trim 后非空，错误信息更友好。
 */
export const AgentModelConfigSchema = type({
	"model?": "string",
	base_url: "string",
	api_key: "string",
	"headers?": { "[string]": "string" },
}).narrow((value, ctx) => {
	if (typeof value.base_url === "string" && value.base_url.trim().length === 0) {
		return ctx.mustBe("base_url a non-empty string");
	}
	if (typeof value.api_key === "string" && value.api_key.trim().length === 0) {
		return ctx.mustBe("api_key a non-empty string");
	}
	if (value.model !== undefined && typeof value.model === "string" && value.model.trim().length === 0) {
		return ctx.mustBe("model a non-empty string when present");
	}
	return true;
});

/** agentModels 表 schema：key → AgentModelConfig */
export const AgentModelsSchema = type({ "[string]": AgentModelConfigSchema });

/** agentRouting 表 schema：key → 路由 key 字符串 */
export const AgentRoutingSchema = type({ "[string]": "string" }).narrow((value, ctx) => {
	for (const [agentKey, routeKey] of Object.entries(value)) {
		if (typeof routeKey !== "string" || routeKey.trim().length === 0) {
			return ctx.mustBe(`agentRouting["${agentKey}"] a non-empty string`);
		}
	}
	return true;
});

/** 顶层 RoutingConfig schema */
export const RoutingConfigSchema = type({
	"agentModels?": AgentModelsSchema,
	"agentRouting?": AgentRoutingSchema,
});

/** schema 推断类型应与 types.ts 手写类型一致 */
export type SchemaRoutingConfig = typeof RoutingConfigSchema.infer;

/**
 * 校验并归一化一份路由配置。
 *
 * - 校验失败时抛出 `AggregateError`-like 数组（arktype 的标准失败形态），
 *   调用方（config-loader）应捕获并打印为可读错误。
 * - 校验通过时返回归一化后的 `RoutingConfig`（trim 字符串、丢弃空条目）。
 *
 * 与 OpenClaude 的差异：OpenClaude 直接读 `settings.json` 后做内联校验；
 * Nexus 单独抽出 schema 模块以便在 CLI 编辑、文件加载、runtime 注入三处复用。
 */
export function validateRoutingConfig(input: unknown): RoutingConfig {
	const result = RoutingConfigSchema(input);
	if (result instanceof type.errors) {
		// arktype 的失败对象有 .summary 字段；抛 Error 让上层捕获处理。
		throw new RoutingConfigValidationError(result.summary, result);
	}

	const config = result as SchemaRoutingConfig;

	// 归一化：trim 字符串、丢弃空条目
	const agentModels: AgentModels = {};
	if (config.agentModels) {
		for (const [key, raw] of Object.entries(config.agentModels)) {
			if (!key.trim()) continue;
			const entry: AgentModelConfig = {
				base_url: raw.base_url.trim(),
				api_key: raw.api_key.trim(),
			};
			if (typeof raw.model === "string" && raw.model.trim()) {
				entry.model = raw.model.trim();
			}
			if (raw.headers && typeof raw.headers === "object") {
				const headers: Record<string, string> = {};
				for (const [h, v] of Object.entries(raw.headers)) {
					if (typeof v === "string" && v.trim()) headers[h] = v;
				}
				if (Object.keys(headers).length > 0) entry.headers = headers;
			}
			agentModels[key] = entry;
		}
	}

	const agentRouting: AgentRouting = {};
	if (config.agentRouting) {
		for (const [agentKey, routeKey] of Object.entries(config.agentRouting)) {
			if (!agentKey.trim() || typeof routeKey !== "string" || !routeKey.trim()) continue;
			agentRouting[agentKey.trim()] = (routeKey as string).trim();
		}
	}

	return {
		...(Object.keys(agentModels).length > 0 && { agentModels }),
		...(Object.keys(agentRouting).length > 0 && { agentRouting }),
	};
}

/** schema 校验失败错误 */
export class RoutingConfigValidationError extends Error {
	readonly issues: unknown;
	constructor(summary: string, issues: unknown) {
		super(summary);
		this.name = "RoutingConfigValidationError";
		this.issues = issues;
	}
}
