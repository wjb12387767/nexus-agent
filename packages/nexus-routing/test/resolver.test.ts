/**
 * Nexus Routing — 路由解析器单测。
 *
 * 覆盖路由优先级：
 * - explicit（task 工具显式指定）> routing > default > global（返回 null）
 * - 归一化匹配（case / hyphen / underscore 不敏感）
 * - agentModels key 与远端 model 名映射（`model` 字段）
 * - 配置错误场景（routeKey 命中但 agentModels 无对应条目）
 * - bridge 注册幂等性
 */
import { expect, describe, test, beforeEach } from "bun:test";
import {
	type AgentModelConfig,
	type AgentRouting,
	type ModelRegistryLike,
	type ProviderConfigInputLike,
	type RoutingConfig,
	NEXUS_ROUTING_PROVIDER_NAME,
	NEXUS_ROUTING_SOURCE_ID,
	buildNormalizedRouting,
	buildProviderConfigInput,
	normalizeAgentKey,
	registerAgentModelsInRegistry,
	resetBridgeStateForTests,
	resolveAgentModelProvider,
	resolveAgentRouting,
	toProviderOverride,
	validateRoutingConfig,
} from "../src/index";

// ============================================================
// 测试夹具
// ============================================================

const deepseekEntry: AgentModelConfig = {
	base_url: "https://api.deepseek.com/v1",
	api_key: "sk-deepseek",
};

const zaiEntry: AgentModelConfig = {
	model: "glm-5.1",
	base_url: "https://api.z.ai/api/coding/paas/v4",
	api_key: "sk-zai",
};

const gpt4oEntry: AgentModelConfig = {
	model: "gpt-4o",
	base_url: "https://api.openai.com/v1",
	api_key: "sk-openai",
};

const fullConfig: RoutingConfig = {
	agentModels: {
		"deepseek-v4-flash": deepseekEntry,
		"zai-default": zaiEntry,
		"gpt-4o": gpt4oEntry,
	},
	agentRouting: {
		Explore: "deepseek-v4-flash",
		Plan: "gpt-4o",
		"general-purpose": "gpt-4o",
		"frontend-dev": "zai-default",
		default: "gpt-4o",
	},
};

// ============================================================
// normalizeAgentKey
// ============================================================

describe("normalizeAgentKey", () => {
	test("小写化", () => {
		expect(normalizeAgentKey("Explore")).toBe("explore");
		expect(normalizeAgentKey("Plan")).toBe("plan");
	});

	test("去掉 - 和 _", () => {
		expect(normalizeAgentKey("general-purpose")).toBe("generalpurpose");
		expect(normalizeAgentKey("frontend_dev")).toBe("frontenddev");
		expect(normalizeAgentKey("Mixed-Case_Name")).toBe("mixedcasename");
	});
});

// ============================================================
// toProviderOverride
// ============================================================

describe("toProviderOverride", () => {
	test("条目缺失返回 null", () => {
		expect(toProviderOverride("missing", undefined)).toBeNull();
	});

	test("api_key 为空返回 null", () => {
		expect(toProviderOverride("k", { base_url: "https://x", api_key: "" })).toBeNull();
		expect(toProviderOverride("k", { base_url: "https://x", api_key: "   " })).toBeNull();
	});

	test("base_url 为空返回 null", () => {
		expect(toProviderOverride("k", { base_url: "", api_key: "sk-x" })).toBeNull();
	});

	test("省略 model 时 routeKey 作为 model 名", () => {
		const o = toProviderOverride("deepseek-v4-flash", deepseekEntry);
		expect(o).not.toBeNull();
		expect(o?.model).toBe("deepseek-v4-flash");
		expect(o?.baseURL).toBe("https://api.deepseek.com/v1");
		expect(o?.apiKey).toBe("sk-deepseek");
	});

	test("条目内 model 优先作为远端模型名", () => {
		const o = toProviderOverride("zai-default", zaiEntry);
		expect(o?.model).toBe("glm-5.1");
		expect(o?.baseURL).toBe("https://api.z.ai/api/coding/paas/v4");
	});

	test("headers 透传", () => {
		const o = toProviderOverride("k", {
			base_url: "https://x",
			api_key: "sk",
			headers: { "X-Custom": "v", "X-Empty": "" },
		});
		expect(o?.headers).toEqual({ "X-Custom": "v" });
	});
});

// ============================================================
// buildNormalizedRouting
// ============================================================

describe("buildNormalizedRouting", () => {
	test("空 routing 返回空 Map", () => {
		expect(buildNormalizedRouting(undefined).size).toBe(0);
		expect(buildNormalizedRouting({}).size).toBe(0);
	});

	test("归一化后建索引", () => {
		const routing: AgentRouting = { "Explore-Agent": "ds", frontend_dev: "zai" };
		const m = buildNormalizedRouting(routing);
		expect(m.get("exploreagent")).toBe("ds");
		expect(m.get("frontenddev")).toBe("zai");
	});

	test("collision 时第一次胜出 + 回调通知", () => {
		const routing: AgentRouting = { "explore-agent": "ds", explore_agent: "zai" };
		const collisions: Array<{ key: string; normalized: string }> = [];
		const m = buildNormalizedRouting(routing, (key, normalizedKey) => {
			collisions.push({ key, normalized: normalizedKey });
		});
		expect(m.get("exploreagent")).toBe("ds");
		expect(collisions).toHaveLength(1);
		expect(collisions[0].key).toBe("explore_agent");
		expect(collisions[0].normalized).toBe("exploreagent");
	});
});

// ============================================================
// resolveAgentRouting — 优先级测试
// ============================================================

describe("resolveAgentRouting 优先级", () => {
	test("config 为 null 返回 null（global 回落）", () => {
		expect(resolveAgentRouting({ config: null, agentName: "Explore" })).toBeNull();
		expect(resolveAgentRouting({ config: undefined, agentName: "Explore" })).toBeNull();
	});

	test("config 无 agentModels 返回 null", () => {
		expect(
			resolveAgentRouting({
				config: { agentRouting: { Explore: "ds" } },
				agentName: "Explore",
			}),
		).toBeNull();
	});

	test("explicit > routing：toolSpecifiedModel 命中 agentModels 时优先", () => {
		// agentName 是 Explore（routing 命中 deepseek-v4-flash），
		// 但 toolSpecifiedModel 显式指定 zai-default —— explicit 优先
		const r = resolveAgentRouting({
			config: fullConfig,
			toolSpecifiedModel: "zai-default",
			agentName: "Explore",
			subagentType: "general-purpose",
		});
		expect(r).not.toBeNull();
		expect(r?.source).toBe("explicit");
		expect(r?.routeKey).toBe("zai-default");
		expect(r?.providerOverride.model).toBe("glm-5.1");
		expect(r?.modelPattern).toBe("nexus-routing/zai-default");
	});

	test("explicit 不命中 agentModels 时返回 null（不回落到 routing）", () => {
		// toolSpecifiedModel="custom-model" 不是 agentModels key —— 与 OpenClaude 一致不回落
		const r = resolveAgentRouting({
			config: fullConfig,
			toolSpecifiedModel: "custom-model",
			agentName: "Explore",
		});
		expect(r).toBeNull();
	});

	test("routing 按 agentName 命中", () => {
		const r = resolveAgentRouting({
			config: fullConfig,
			agentName: "Explore",
		});
		expect(r?.source).toBe("routing");
		expect(r?.routeKey).toBe("deepseek-v4-flash");
		expect(r?.providerOverride.model).toBe("deepseek-v4-flash");
	});

	test("routing 按 subagentType 命中（agentName 未命中时）", () => {
		// agentName="Unknown" 不在 routing 表，subagentType="general-purpose" 命中
		const r = resolveAgentRouting({
			config: fullConfig,
			agentName: "Unknown",
			subagentType: "general-purpose",
		});
		expect(r?.source).toBe("routing");
		expect(r?.routeKey).toBe("gpt-4o");
	});

	test("routing 按 agentName 优先于 subagentType", () => {
		// 同时给 agentName=Explore 和 subagentType=general-purpose
		// agentName 命中优先
		const r = resolveAgentRouting({
			config: fullConfig,
			agentName: "Explore",
			subagentType: "general-purpose",
		});
		expect(r?.routeKey).toBe("deepseek-v4-flash");
	});

	test("default 兜底命中", () => {
		const r = resolveAgentRouting({
			config: fullConfig,
			agentName: "Some-New-Agent",
			subagentType: "unknown-type",
		});
		expect(r?.source).toBe("default");
		expect(r?.routeKey).toBe("gpt-4o");
	});

	test("归一化匹配：大小写 / - / _ 不敏感", () => {
		const r1 = resolveAgentRouting({
			config: fullConfig,
			agentName: "explore", // 小写
		});
		expect(r1?.routeKey).toBe("deepseek-v4-flash");

		const r2 = resolveAgentRouting({
			config: fullConfig,
			agentName: "Frontend_Dev", // 大写 + _
		});
		expect(r2?.routeKey).toBe("zai-default");
	});

	test("global 回落：无 default 且 agentName/subagentType 都未命中", () => {
		const config: RoutingConfig = {
			agentModels: { "ds": deepseekEntry },
			agentRouting: { Explore: "ds" }, // 没有 default
		};
		const r = resolveAgentRouting({
			config,
			agentName: "Unknown",
			subagentType: "unknown",
		});
		expect(r).toBeNull();
	});

	test("routeKey 命中但 agentModels 无对应条目 → 跳过到下一候选", () => {
		// routing 表指向不存在的 agentModels key —— 视为配置错误，继续走 fallback
		const config: RoutingConfig = {
			agentModels: { "real-key": deepseekEntry },
			agentRouting: {
				Explore: "missing-key", // 指向不存在的 agentModels 条目
				default: "real-key",
			},
		};
		const r = resolveAgentRouting({
			config,
			agentName: "Explore",
		});
		// Explore 命中 "missing-key"，但 agentModels 里没有 → 跳过到 default
		expect(r?.source).toBe("default");
		expect(r?.routeKey).toBe("real-key");
	});

	test("agentDefinitionModel 兜底命中（OpenClaude 兼容）", () => {
		// 当 routing 全未命中且无 default，agent 定义里的 model 作为 agentModels key 直接命中
		const config: RoutingConfig = {
			agentModels: { "ds": deepseekEntry },
			// 无 agentRouting
		};
		const r = resolveAgentRouting({
			config,
			agentName: "Unknown",
			subagentType: "unknown",
			agentDefinitionModel: "ds",
		});
		expect(r?.source).toBe("routing");
		expect(r?.routeKey).toBe("ds");
	});
});

// ============================================================
// resolveAgentModelProvider
// ============================================================

describe("resolveAgentModelProvider", () => {
	test("精确匹配（不归一化）", () => {
		const o = resolveAgentModelProvider("deepseek-v4-flash", fullConfig);
		expect(o?.model).toBe("deepseek-v4-flash");
	});

	test("不存在的 key 返回 null", () => {
		expect(resolveAgentModelProvider("nonexistent", fullConfig)).toBeNull();
	});

	test("大小写敏感（与 OpenClaude 一致）", () => {
		// "Deepseek-v4-flash" 不匹配 "deepseek-v4-flash"
		expect(resolveAgentModelProvider("Deepseek-v4-flash", fullConfig)).toBeNull();
	});

	test("空名 / 空白名返回 null", () => {
		expect(resolveAgentModelProvider("", fullConfig)).toBeNull();
		expect(resolveAgentModelProvider("   ", fullConfig)).toBeNull();
		expect(resolveAgentModelProvider(undefined, fullConfig)).toBeNull();
	});

	test("config 为 null 返回 null", () => {
		expect(resolveAgentModelProvider("ds", null)).toBeNull();
	});
});

// ============================================================
// validateRoutingConfig
// ============================================================

describe("validateRoutingConfig", () => {
	test("合法配置通过", () => {
		const c = validateRoutingConfig({
			agentModels: {
				ds: { base_url: "https://x", api_key: "sk" },
			},
			agentRouting: { Explore: "ds", default: "ds" },
		});
		expect(c.agentModels?.ds.base_url).toBe("https://x");
		expect(c.agentRouting?.Explore).toBe("ds");
	});

	test("trim 字符串", () => {
		const c = validateRoutingConfig({
			agentModels: {
				ds: { base_url: "  https://x  ", api_key: "  sk  ", model: "  glm  " },
			},
		});
		expect(c.agentModels?.ds.base_url).toBe("https://x");
		expect(c.agentModels?.ds.api_key).toBe("sk");
		expect(c.agentModels?.ds.model).toBe("glm");
	});

	test("空 api_key 抛错", () => {
		expect(() =>
			validateRoutingConfig({
				agentModels: { ds: { base_url: "https://x", api_key: "" } },
			}),
		).toThrow();
	});

	test("空 base_url 抛错", () => {
		expect(() =>
			validateRoutingConfig({
				agentModels: { ds: { base_url: "", api_key: "sk" } },
			}),
		).toThrow();
	});

	test("空 agentRouting value 抛错", () => {
		expect(() =>
			validateRoutingConfig({
				agentModels: { ds: { base_url: "https://x", api_key: "sk" } },
				agentRouting: { Explore: "" },
			}),
		).toThrow();
	});

	test("丢弃空条目（agentModels key 为空）", () => {
		const c = validateRoutingConfig({
			agentModels: {
				"": { base_url: "https://x", api_key: "sk" },
				ds: { base_url: "https://x", api_key: "sk" },
			},
		});
		expect(Object.keys(c.agentModels ?? {})).toEqual(["ds"]);
	});

	test("空 headers 被丢弃", () => {
		const c = validateRoutingConfig({
			agentModels: {
				ds: { base_url: "https://x", api_key: "sk", headers: { "X": "" } },
			},
		});
		expect(c.agentModels?.ds.headers).toBeUndefined();
	});
});

// ============================================================
// registry-bridge
// ============================================================

describe("registry-bridge", () => {
	beforeEach(() => {
		resetBridgeStateForTests();
	});

	test("buildProviderConfigInput 返回 null（无 agentModels）", () => {
		expect(buildProviderConfigInput({})).toBeNull();
		expect(buildProviderConfigInput({ agentRouting: { Explore: "ds" } })).toBeNull();
	});

	test("buildProviderConfigInput 构造合成 provider config", () => {
		const input = buildProviderConfigInput(fullConfig);
		expect(input).not.toBeNull();
		expect(input?.api).toBe("openai-completions");
		expect(input?.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(input?.apiKey).toBe("sk-deepseek");
		expect(input?.models).toHaveLength(3);
		const ids = input?.models.map(m => m.id).sort();
		expect(ids).toEqual(["deepseek-v4-flash", "gpt-4o", "zai-default"].sort());
	});

	test("registerAgentModelsInRegistry 调用 registerProvider", () => {
		const calls: Array<{ name: string; sourceId?: string }> = [];
		const fakeRegistry: ModelRegistryLike = {
			registerProvider(providerName, config, sourceId) {
				calls.push({ name: providerName, sourceId });
			},
		};
		const registered = registerAgentModelsInRegistry(fakeRegistry, fullConfig);
		expect(registered).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe(NEXUS_ROUTING_PROVIDER_NAME);
		expect(calls[0].sourceId).toBe(NEXUS_ROUTING_SOURCE_ID);
	});

	test("registerAgentModelsInRegistry 幂等：相同 config 重复调用不重新注册", () => {
		let callCount = 0;
		const fakeRegistry: ModelRegistryLike = {
			registerProvider() {
				callCount++;
			},
		};
		registerAgentModelsInRegistry(fakeRegistry, fullConfig);
		registerAgentModelsInRegistry(fakeRegistry, fullConfig);
		registerAgentModelsInRegistry(fakeRegistry, fullConfig);
		expect(callCount).toBe(1);
	});

	test("registerAgentModelsInRegistry 配置变化时重新注册", () => {
		let callCount = 0;
		const fakeRegistry: ModelRegistryLike = {
			registerProvider() {
				callCount++;
			},
		};
		registerAgentModelsInRegistry(fakeRegistry, fullConfig);
		// 改 agentModels（增加一个条目）
		const updated: RoutingConfig = {
			...fullConfig,
			agentModels: {
				...fullConfig.agentModels,
				"new-route": { base_url: "https://new", api_key: "sk-new" },
			},
		};
		registerAgentModelsInRegistry(fakeRegistry, updated);
		expect(callCount).toBe(2);
	});

	test("registerAgentModelsInRegistry 空 agentModels 不调用 registerProvider", () => {
		let callCount = 0;
		const fakeRegistry: ModelRegistryLike = {
			registerProvider() {
				callCount++;
			},
		};
		expect(registerAgentModelsInRegistry(fakeRegistry, {})).toBe(false);
		expect(registerAgentModelsInRegistry(fakeRegistry, { agentRouting: { Explore: "ds" } })).toBe(false);
		expect(callCount).toBe(0);
	});
});
