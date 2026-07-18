/**
 * Nexus Routing — 配置加载器。
 *
 * 从 `~/.nexus/config.json` 加载并校验路由配置。
 *
 * 与 OpenClaude 的差异：OpenClaude 把 `agentModels`/`agentRouting` 内联在
 * `~/.openclaude.json` 里；Nexus 独立成 `~/.nexus/config.json`，避免与
 * omp 自身的 settings 文件冲突（omp 有自己的 `~/.omp/agent/config.yml`）。
 *
 * 加载顺序：
 * 1. `$NEXUS_ROUTING_CONFIG` 环境变量指向的文件（测试 / CI 覆盖用）
 * 2. `~/.nexus/config.json`（默认路径）
 *
 * 文件不存在时返回 `null`（路由功能静默禁用，调用方走 omp 全局 provider）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateRoutingConfig, RoutingConfigValidationError } from "./schema";
import type { RoutingConfig } from "./types";

/** 环境变量：覆盖默认配置文件路径（测试 / CI 用） */
export const NEXUS_ROUTING_CONFIG_ENV = "NEXUS_ROUTING_CONFIG";

/** 默认配置目录：`~/.nexus/` */
export const NEXUS_CONFIG_DIR = ".nexus";

/** 默认配置文件名 */
export const NEXUS_CONFIG_FILENAME = "config.json";

/**
 * 解析默认配置文件路径：`~/.nexus/config.json`。
 *
 * `~` 在 Windows 上由 `os.homedir()` 处理（返回 `C:\Users\<user>`）。
 */
export function getDefaultConfigPath(): string {
	return path.join(os.homedir(), NEXUS_CONFIG_DIR, NEXUS_CONFIG_FILENAME);
}

/**
 * 解析实际使用的配置文件路径。
 *
 * 优先 `$NEXUS_ROUTING_CONFIG` 环境变量；否则用默认路径。
 */
export function resolveConfigPath(): string {
	const envPath = process.env[NEXUS_ROUTING_CONFIG_ENV];
	if (envPath && envPath.trim()) return path.resolve(envPath.trim());
	return getDefaultConfigPath();
}

/** 加载结果 */
export interface LoadResult {
	/** 已加载并校验的配置；未配置时为 null */
	config: RoutingConfig | null;
	/** 配置文件路径（实际加载的） */
	path: string;
	/** 加载状态 */
	status: "loaded" | "missing" | "invalid" | "empty";
	/** 校验失败时的错误信息（status === "invalid" 时有值） */
	error?: string;
}

/**
 * 同步加载路由配置。
 *
 * 同步实现是因为 task 工具的 `#runSpawn` 在 hot path 上，每次 spawn 都要
 * 读一次最新配置（用户可能在 spawn 之间编辑了配置）。文件不存在或校验
 * 失败时返回带 `status` 的结果，调用方决定是否打印 warning。
 *
 * 文件读取用 `fs.readFileSync` —— 配置文件预期 < 10KB，同步读取开销可忽略。
 */
export function loadRoutingConfigSync(configPath?: string): LoadResult {
	const resolvedPath = configPath ?? resolveConfigPath();

	let raw: string;
	try {
		raw = fs.readFileSync(resolvedPath, "utf8");
	} catch (err: unknown) {
		// 文件不存在：路由功能静默禁用
		if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
			return { config: null, path: resolvedPath, status: "missing" };
		}
		// 其他 IO 错误（权限等）：当作 invalid 报告
		return {
			config: null,
			path: resolvedPath,
			status: "invalid",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		return {
			config: null,
			path: resolvedPath,
			status: "invalid",
			error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	try {
		const config = validateRoutingConfig(parsed);
		// 校验通过但 agentModels/agentRouting 都为空：算 "empty"
		if (!config.agentModels && !config.agentRouting) {
			return { config: null, path: resolvedPath, status: "empty" };
		}
		// 只有 agentRouting 没有 agentModels：无法生效，算 empty
		if (config.agentRouting && !config.agentModels) {
			return { config: null, path: resolvedPath, status: "empty" };
		}
		return { config, path: resolvedPath, status: "loaded" };
	} catch (err: unknown) {
		const message = err instanceof RoutingConfigValidationError ? err.message : String(err);
		return { config: null, path: resolvedPath, status: "invalid", error: message };
	}
}

/**
 * 异步加载路由配置（与同步版本等价，仅 wrapper）。
 *
 * 提供给异步上下文（如 CLI 子命令）使用，避免阻塞事件循环。
 */
export async function loadRoutingConfig(configPath?: string): Promise<LoadResult> {
	return loadRoutingConfigSync(configPath);
}

/**
 * 把一份 RoutingConfig 序列化为 JSON 字符串（用于写回文件）。
 *
 * 保持稳定的 key 顺序（agentModels 在前，agentRouting 在后），方便
 * 用户阅读和 git diff。
 */
export function serializeRoutingConfig(config: RoutingConfig): string {
	const out: Record<string, unknown> = {};
	if (config.agentModels) out.agentModels = config.agentModels;
	if (config.agentRouting) out.agentRouting = config.agentRouting;
	return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * 把配置写回文件（原子写：先写临时文件再 rename）。
 *
 * 用于 CLI 子命令 `config routing` 编辑后保存。
 */
export function saveRoutingConfig(config: RoutingConfig, configPath?: string): void {
	const resolvedPath = configPath ?? resolveConfigPath();
	const dir = path.dirname(resolvedPath);
	fs.mkdirSync(dir, { recursive: true });
	const content = serializeRoutingConfig(config);
	// Windows 上 fs.renameSync 同分区原子；跨分区会失败，回退到直接写
	const tmpPath = `${resolvedPath}.tmp`;
	fs.writeFileSync(tmpPath, content, "utf8");
	try {
		fs.renameSync(tmpPath, resolvedPath);
	} catch {
		fs.unlinkSync(resolvedPath);
		fs.renameSync(tmpPath, resolvedPath);
	}
}
