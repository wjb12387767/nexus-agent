/**
 * Nexus Routing CLI 子命令处理器。
 *
 * 入口形式：`nexus config routing <subcommand> [args] [--flags]`
 *
 * 支持的子命令：
 *
 * - `list` / `show`：打印当前 agentModels + agentRouting（`--json` 输出 JSON）
 * - `path`：打印配置文件实际路径
 * - `init`：创建空配置文件（已存在则不覆盖）
 * - `add-model <routeKey> <base_url> <api_key> [--model <m>] [--header K:V]`：
 *     新增 / 覆盖一条 agentModels 条目；缺失参数时交互式询问
 * - `remove-model <routeKey>`：删除一条 agentModels 条目（连带清理引用它的 agentRouting）
 * - `add-route <agent> <routeKey>`：新增 / 覆盖一条 agentRouting 条目
 * - `remove-route <agent>`：删除一条 agentRouting 条目
 * - `reset`：清空全部 routing 配置（交互式确认）
 * - `help` / 无子命令：打印帮助
 *
 * 设计原则：
 * 1. **不修改 omp settings**：routing 配置独立于 omp 的 settings 文件，
 *    存在 `~/.nexus/config.json`，由 `@nexus-agent/routing` 自管。
 * 2. **幂等写入**：每次操作都 reload 最新文件、修改、原子写回，
 *    避免覆盖用户在另一个 shell 里手动编辑的内容。
 * 3. **错误友好**：所有失败都打印红色错误并 `process.exit(1)`，
 *    与 `config-cli.ts` 的现有风格一致。
 * 4. **交互式补全**：`add-model` / `add-route` 缺失位置参数时，
 *    通过 `readline` 提示用户输入（task 7.5 要求的“交互式配置”）。
 */
import * as readline from "node:readline";
import {
	type AgentModelConfig,
	type AgentModels,
	type AgentRouting,
	type RoutingConfig,
	getDefaultConfigPath,
	loadRoutingConfig,
	resolveConfigPath,
	saveRoutingConfig,
	serializeRoutingConfig,
	validateRoutingConfig,
} from "@nexus-agent/routing";
import { APP_NAME, logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

// =============================================================================
// 类型与常量
// =============================================================================

type Subcommand =
	| "list"
	| "show"
	| "path"
	| "init"
	| "add-model"
	| "remove-model"
	| "add-route"
	| "remove-route"
	| "reset"
	| "help";

const SUBCOMMANDS: Subcommand[] = [
	"list",
	"show",
	"path",
	"init",
	"add-model",
	"remove-model",
	"add-route",
	"remove-route",
	"reset",
	"help",
];

interface ParsedFlags {
	json: boolean;
	help: boolean;
	positional: string[];
	/** `--model <value>`（add-model 用） */
	model?: string;
	/** `--header K:V`（add-model 用，可多次） */
	headers: Array<[string, string]>;
}

// =============================================================================
// 参数解析
// =============================================================================

function parseArgs(argv: string[]): { sub: Subcommand | null; flags: ParsedFlags } {
	const flags: ParsedFlags = { json: false, help: false, positional: [], headers: [] };
	let sub: Subcommand | null = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg) continue;

		if (arg === "--json") {
			flags.json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			flags.help = true;
			continue;
		}
		if (arg === "--model") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) {
				console.error(chalk.red("--model requires a value"));
				process.exit(1);
			}
			flags.model = next;
			i++;
			continue;
		}
		if (arg.startsWith("--model=")) {
			flags.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--header") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) {
				console.error(chalk.red("--header requires a value in the form Key:Value"));
				process.exit(1);
			}
			const parsed = parseHeader(next);
			if (!parsed) {
				console.error(chalk.red(`Invalid --header value: ${next}. Expected Key:Value`));
				process.exit(1);
			}
			flags.headers.push(parsed);
			i++;
			continue;
		}
		if (arg.startsWith("--header=")) {
			const value = arg.slice("--header=".length);
			const parsed = parseHeader(value);
			if (!parsed) {
				console.error(chalk.red(`Invalid --header value: ${value}. Expected Key:Value`));
				process.exit(1);
			}
			flags.headers.push(parsed);
			continue;
		}
		if (arg.startsWith("--")) {
			console.error(chalk.red(`Unknown flag: ${arg}`));
			process.exit(1);
		}

		if (sub === null) {
			if (!SUBCOMMANDS.includes(arg as Subcommand)) {
				console.error(chalk.red(`Unknown routing subcommand: ${arg}`));
				console.error(dimValidSubs());
				process.exit(1);
			}
			sub = arg as Subcommand;
		} else {
			flags.positional.push(arg);
		}
	}

	return { sub, flags };
}

function parseHeader(value: string): [string, string] | null {
	const idx = value.indexOf(":");
	if (idx <= 0 || idx === value.length - 1) return null;
	const key = value.slice(0, idx).trim();
	const val = value.slice(idx + 1).trim();
	if (!key || !val) return null;
	return [key, val];
}

function dimValidSubs(): string {
	return chalk.dim(`Valid subcommands: ${SUBCOMMANDS.join(", ")}`);
}

// =============================================================================
// 配置读写辅助
// =============================================================================

interface LoadedImage {
	config: RoutingConfig;
	path: string;
}

/**
 * 加载现有配置；文件不存在时返回空配置（subcommand 自己决定是否报错）。
 *
 * 校验失败的文件直接报错退出 —— 编辑命令需要从合法状态出发，
 * 否则 saveRoutingConfig 会把用户的非法内容覆盖掉。
 */
async function loadEditable(): Promise<LoadedImage> {
	const result = await loadRoutingConfig();
	if (result.status === "invalid") {
		console.error(
			chalk.red(`Routing config at ${result.path} is invalid: ${result.error ?? "unknown error"}`),
		);
		console.error(chalk.dim("Fix the file manually, or run `nexus config routing reset` to clear it."));
		process.exit(1);
	}
	// missing / empty 都返回空配置骨架
	const config: RoutingConfig = result.config ?? {};
	return { config, path: result.path };
}

/**
 * 校验并保存配置。校验失败时报错退出，不写入。
 */
function validateAndSave(config: RoutingConfig, path: string): void {
	try {
		// 通过 validateRoutingConfig 触发归一化（trim / 丢空条目）
		const normalized = validateRoutingConfig(config);
		// validateRoutingConfig 返回的对象可能去掉空表，写回时保留骨架
		const toSave: RoutingConfig = {};
		if (normalized.agentModels && Object.keys(normalized.agentModels).length > 0) {
			toSave.agentModels = normalized.agentModels;
		}
		if (normalized.agentRouting && Object.keys(normalized.agentRouting).length > 0) {
			toSave.agentRouting = normalized.agentRouting;
		}
		saveRoutingConfig(toSave, path);
	} catch (err) {
		console.error(
			chalk.red(
				`Failed to save routing config: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		process.exit(1);
	}
}

// =============================================================================
// 交互式 readline
// =============================================================================

async function promptLine(rl: readline.Interface, question: string): Promise<string> {
	return new Promise<string>(resolve => {
		rl.question(question, answer => resolve(answer));
	});
}

async function promptRequired(rl: readline.Interface, label: string): Promise<string> {
	for (;;) {
		const answer = (await promptLine(rl, `${label}: `)).trim();
		if (answer) return answer;
		console.error(chalk.red("  value is required"));
	}
}

/**
 * 交互式补全 `add-model` 的缺失参数。
 *
 * 用户已经给出的位置参数（positional）按顺序填入 routeKey / baseUrl / apiKey，
 * 缺失的依次提示输入。
 */
async function interactiveFillAddModel(
	positional: string[],
): Promise<{ routeKey: string; baseUrl: string; apiKey: string }> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const routeKey = positional[0]?.trim() || (await promptRequired(rl, "Route key (e.g. deepseek-v4-flash)"));
		const baseUrl =
			positional[1]?.trim() || (await promptRequired(rl, "Base URL (e.g. https://api.deepseek.com/v1)"));
		const apiKey = positional[2]?.trim() || (await promptRequired(rl, "API key"));
		return { routeKey, baseUrl, apiKey };
	} finally {
		rl.close();
	}
}

/**
 * 交互式补全 `add-route` 的缺失参数。
 */
async function interactiveFillAddRoute(
	positional: string[],
): Promise<{ agent: string; routeKey: string }> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const agent = positional[0]?.trim() || (await promptRequired(rl, "Agent name (e.g. Explore, or 'default')"));
		const routeKey = positional[1]?.trim() || (await promptRequired(rl, "Route key (must exist in agentModels)"));
		return { agent, routeKey };
	} finally {
		rl.close();
	}
}

/**
 * 交互式 yes/no 确认。默认 No（避免误操作清空配置）。
 */
async function promptConfirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await promptLine(rl, `${question} [y/N] `)).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

// =============================================================================
// 子命令实现
// =============================================================================

async function handleList(flags: ParsedFlags): Promise<void> {
	const result = await loadRoutingConfig();
	if (flags.json) {
		const payload = {
			path: result.path,
			status: result.status,
			config: result.config ?? {},
		};
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold(`Nexus routing config`));
	console.log(chalk.dim(`  path:   ${result.path}`));
	console.log(chalk.dim(`  status: ${result.status}`));
	console.log("");

	if (!result.config) {
		console.log(chalk.dim("(no routing configured)"));
		console.log(chalk.dim(`Run '${APP_NAME} config routing init' to create an empty config,`));
		console.log(chalk.dim(`or '${APP_NAME} config routing add-model <key> <baseUrl> <apiKey>' to get started.`));
		return;
	}

	const { agentModels, agentRouting } = result.config;

	console.log(chalk.bold.blue("[agentModels]"));
	if (agentModels && Object.keys(agentModels).length > 0) {
		for (const [key, cfg] of Object.entries(agentModels)) {
			const model = cfg.model ? chalk.cyan(cfg.model) : chalk.dim("(= key)");
			const headers = cfg.headers && Object.keys(cfg.headers).length > 0
				? chalk.dim(` headers=[${Object.keys(cfg.headers).join(",")}]`)
				: "";
			console.log(`  ${chalk.white(key)} ${model} ${chalk.yellow(cfg.base_url)}${headers}`);
		}
	} else {
		console.log(chalk.dim("  (empty)"));
	}
	console.log("");

	console.log(chalk.bold.blue("[agentRouting]"));
	if (agentRouting && Object.keys(agentRouting).length > 0) {
		for (const [agent, routeKey] of Object.entries(agentRouting)) {
			const valid = agentModels && agentModels[routeKey] ? chalk.green("✓") : chalk.red("✗");
			console.log(`  ${valid} ${chalk.white(agent)} → ${chalk.yellow(routeKey)}`);
		}
	} else {
		console.log(chalk.dim("  (empty)"));
	}
}

function handlePath(): void {
	console.log(resolveConfigPath());
}

async function handleInit(): Promise<void> {
	const fs = await import("node:fs/promises");
	const path = resolveConfigPath();
	try {
		await fs.access(path);
		console.log(chalk.dim(`Config already exists at ${path} (left untouched).`));
		return;
	} catch {
		// 不存在，创建空骨架
	}
	const empty: RoutingConfig = { agentModels: {}, agentRouting: {} };
	try {
		saveRoutingConfig(empty, path);
		console.log(chalk.green(`Initialized empty routing config at ${path}`));
	} catch (err) {
		console.error(
			chalk.red(`Failed to init config: ${err instanceof Error ? err.message : String(err)}`),
		);
		process.exit(1);
	}
}

async function handleAddModel(flags: ParsedFlags): Promise<void> {
	const { routeKey, baseUrl, apiKey } = await interactiveFillAddModel(flags.positional);
	const { config, path } = await loadEditable();

	const agentModels: AgentModels = { ...(config.agentModels ?? {}) };
	const entry: AgentModelConfig = { base_url: baseUrl, api_key: apiKey };
	if (flags.model) entry.model = flags.model;
	if (flags.headers.length > 0) {
		const headers: Record<string, string> = {};
		for (const [k, v] of flags.headers) headers[k] = v;
		entry.headers = headers;
	}
	agentModels[routeKey] = entry;
	config.agentModels = agentModels;

	validateAndSave(config, path);
	console.log(chalk.green(`Saved agentModel '${routeKey}' → ${baseUrl}`));
}

async function handleRemoveModel(flags: ParsedFlags): Promise<void> {
	const routeKey = flags.positional[0]?.trim();
	if (!routeKey) {
		console.error(chalk.red("Usage: nexus config routing remove-model <routeKey>"));
		process.exit(1);
	}
	const { config, path } = await loadEditable();
	if (!config.agentModels || !(routeKey in config.agentModels)) {
		console.error(chalk.red(`agentModel '${routeKey}' not found`));
		process.exit(1);
	}

	// 删除 agentModels 条目，连带清理引用该 key 的 agentRouting 条目
	delete config.agentModels[routeKey];
	if (Object.keys(config.agentModels).length === 0) {
		delete config.agentModels;
	}
	if (config.agentRouting) {
		const staleAgents = Object.entries(config.agentRouting)
			.filter(([, rk]) => rk === routeKey)
			.map(([agent]) => agent);
		for (const agent of staleAgents) {
			delete config.agentRouting[agent];
		}
		if (Object.keys(config.agentRouting).length === 0) {
			delete config.agentRouting;
		}
		if (staleAgents.length > 0) {
			console.log(chalk.dim(`Also removed agentRouting entries: ${staleAgents.join(", ")}`));
		}
	}

	validateAndSave(config, path);
	console.log(chalk.green(`Removed agentModel '${routeKey}'`));
}

async function handleAddRoute(flags: ParsedFlags): Promise<void> {
	const { agent, routeKey } = await interactiveFillAddRoute(flags.positional);
	const { config, path } = await loadEditable();

	if (!config.agentModels || !(routeKey in config.agentModels)) {
		console.error(
			chalk.red(`Route key '${routeKey}' does not exist in agentModels.`),
		);
		console.error(chalk.dim(`Run '${APP_NAME} config routing add-model ${routeKey} <baseUrl> <apiKey>' first.`));
		process.exit(1);
	}

	const agentRouting: AgentRouting = { ...(config.agentRouting ?? {}) };
	agentRouting[agent] = routeKey;
	config.agentRouting = agentRouting;

	validateAndSave(config, path);
	console.log(chalk.green(`Saved agentRouting '${agent}' → '${routeKey}'`));
}

async function handleRemoveRoute(flags: ParsedFlags): Promise<void> {
	const agent = flags.positional[0]?.trim();
	if (!agent) {
		console.error(chalk.red("Usage: nexus config routing remove-route <agent>"));
		process.exit(1);
	}
	const { config, path } = await loadEditable();
	if (!config.agentRouting || !(agent in config.agentRouting)) {
		console.error(chalk.red(`agentRouting entry '${agent}' not found`));
		process.exit(1);
	}

	delete config.agentRouting[agent];
	if (Object.keys(config.agentRouting).length === 0) {
		delete config.agentRouting;
	}

	validateAndSave(config, path);
	console.log(chalk.green(`Removed agentRouting '${agent}'`));
}

async function handleReset(): Promise<void> {
	const path = resolveConfigPath();
	const confirmed = await promptConfirm(
		`Reset routing config at ${path}? This clears ALL agentModels and agentRouting.`,
	);
	if (!confirmed) {
		console.log(chalk.dim("Aborted."));
		return;
	}
	try {
		saveRoutingConfig({}, path);
		console.log(chalk.green(`Reset routing config at ${path}`));
	} catch (err) {
		console.error(
			chalk.red(`Failed to reset config: ${err instanceof Error ? err.message : String(err)}`),
		);
		process.exit(1);
	}
}

function printHelp(): void {
	const lines = [
		`${chalk.bold(`${APP_NAME} config routing`)} - Manage per-agent model routing`,
		"",
		`${chalk.bold("Subcommands:")}`,
		`  list                                  List current agentModels + agentRouting`,
		`  show                                  Alias for 'list'`,
		`  path                                  Print the routing config file path`,
		`  init                                  Create an empty routing config file`,
		`  add-model <key> <baseUrl> <apiKey>    Add or overwrite an agentModels entry`,
		`      [--model <m>] [--header K:V]      (prompts for missing args interactively)`,
		`  remove-model <key>                    Remove an agentModels entry (and dangling routes)`,
		`  add-route <agent> <routeKey>          Add or overwrite an agentRouting entry`,
		`      (prompts for missing args interactively)`,
		`  remove-route <agent>                  Remove an agentRouting entry`,
		`  reset                                 Clear ALL routing config (interactive confirm)`,
		`  help                                  Show this help`,
		"",
		`${chalk.bold("Options:")}`,
		`  --json                                Output as JSON (list/show only)`,
		`  --model <name>                        Real model name for add-model (defaults to <key>)`,
		`  --header K:V                          Extra header for add-model (repeatable)`,
		`  --help, -h                            Show this help`,
		"",
		`${chalk.bold("Routing priority:")}`,
		`  explicit (task tool's --model) > routing (agentRouting by name/type)`,
		`  > default (agentRouting.default) > global (omp parent session model)`,
		"",
		`${chalk.bold("Examples:")}`,
		`  ${APP_NAME} config routing list`,
		`  ${APP_NAME} config routing add-model deepseek-v4-flash https://api.deepseek.com/v1 sk-xxx`,
		`  ${APP_NAME} config routing add-model zai-glm https://api.z.ai/v1 sk-xxx --model glm-5.1`,
		`  ${APP_NAME} config routing add-route Explore deepseek-v4-flash`,
		`  ${APP_NAME} config routing add-route default zai-glm`,
		`  ${APP_NAME} config routing remove-model deepseek-v4-flash`,
		`  ${APP_NAME} config routing reset`,
		"",
		`${chalk.bold("Config file:")}`,
		`  Default: ${getDefaultConfigPath()}`,
		`  Override: $NEXUS_ROUTING_CONFIG=<path>`,
		"",
		`${chalk.bold("Schema:")}`,
		`  ${chalk.dim(serializeRoutingConfig({ agentModels: { "deepseek-v4-flash": { base_url: "https://api.deepseek.com/v1", api_key: "sk-..." } }, agentRouting: { Explore: "deepseek-v4-flash", default: "deepseek-v4-flash" } }))}`,
	];
	console.log(lines.join("\n"));
}

// =============================================================================
// 入口
// =============================================================================

/**
 * Routing CLI 入口。由 `config-cli.ts` 在 `action === "routing"` 时调用。
 *
 * `argv` 是 `nexus config routing` 之后的全部 token（不含 "config" 和 "routing"）。
 *
 * 任何子命令内部的异常都被认为是用户可读错误，由子命令自行打印红色消息
 * 并 `process.exit(1)`；这里的 try/catch 仅作为兜底，确保异常不向上
 * 渗漏到 `runConfigCommand` 影响其它 action。
 */
export async function runRoutingCommand(argv: string[]): Promise<void> {
	const { sub, flags } = parseArgs(argv);

	if (flags.help || sub === null || sub === "help") {
		printHelp();
		return;
	}

	try {
		switch (sub) {
			case "list":
			case "show":
				await handleList(flags);
				break;
			case "path":
				handlePath();
				break;
			case "init":
				await handleInit();
				break;
			case "add-model":
				await handleAddModel(flags);
				break;
			case "remove-model":
				await handleRemoveModel(flags);
				break;
			case "add-route":
				await handleAddRoute(flags);
				break;
			case "remove-route":
				await handleRemoveRoute(flags);
				break;
			case "reset":
				await handleReset();
				break;
			default: {
				const _exhaustive: never = sub;
				logger.warn(`Unhandled routing subcommand: ${_exhaustive as string}`);
				printHelp();
			}
		}
	} catch (err) {
		console.error(
			chalk.red(`Routing command failed: ${err instanceof Error ? err.message : String(err)}`),
		);
		process.exit(1);
	}
}
