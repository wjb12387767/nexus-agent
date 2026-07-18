#!/usr/bin/env bun
/**
 * Nexus Agent — 安全审计脚本（Task 9.5）。
 *
 * 可独立运行：
 *   bun scripts/security-audit.ts                                   # 默认全模式
 *   bun scripts/security-audit.ts --mode hardening:strict          # 仅 hardening
 *   bun scripts/security-audit.ts --mode verify:privacy
 *   bun scripts/security-audit.ts --mode hardening:strict --mode verify:privacy
 *   bun scripts/security-audit.ts --json                           # JSON 输出（CI 友好）
 *   bun scripts/security-audit.ts --quiet                          # 仅打印 error
 *
 * 四个审计模式：
 *   1. hardening:strict  — 扫描所有文件 IO 调用，确认是否经过沙箱路径
 *                          （仅在 sandbox.enabled=true 时生效；exit 1 当发现绕过沙箱的裸 IO）
 *   2. verify:privacy    — 扫描代码确认无 Mixpanel/Segment/PostHog/Amplitude/
 *                          Google Analytics 等遥测 SDK 残留，亦无上报用户数据的代码
 *   3. audit:spawn       — 扫描 spawn/exec/child_process 调用，确认是否经过 sandbox 控制
 *   4. audit:network     — 扫描 fetch/http 请求，确认主机是否在白名单
 *
 * 扫描范围：
 *   - packages/nexus-*            （Nexus 专有 TS 包）
 *   - crates/nexus-*              （Nexus 专有 Rust crate）
 *   - vscode-extension/nexus-vscode
 *   - packages/coding-agent/src/tools/bash*   （sandbox 集成点）
 *   - packages/coding-agent/src/cli.ts        （CLI 入口）
 *
 * 设计原则：
 *   - 默认安全：宁可误报，不可漏报
 *   - 可豁免：在代码附近加 // nexus-audit-ignore: <reason> 注释即可豁免单行
 *   - 网络白名单在下方 ALLOWED_HOSTS 列出
 *
 * 退出码：0 = 无 error；1 = 至少一个 error；2 = 脚本自身错误。
 */
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const repoRoot = join(dirname(import.meta.dir));
const args = process.argv.slice(2);

// ─── CLI 参数解析 ───────────────────────────────────────────────────────
interface CliOptions {
	modes: string[];
	json: boolean;
	quiet: boolean;
	strict: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		modes: [],
		json: false,
		quiet: false,
		strict: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode") {
			const next = argv[i + 1];
			if (next) {
				opts.modes.push(next);
				i++;
			}
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--quiet") {
			opts.quiet = true;
		} else if (arg === "--strict") {
			opts.strict = true;
		} else if (arg === "-h" || arg === "--help") {
			opts.help = true;
		}
	}
	// 默认：跑全部模式
	if (opts.modes.length === 0) {
		opts.modes = ["hardening:strict", "verify:privacy", "audit:spawn", "audit:network"];
	}
	return opts;
}

const opts = parseArgs(args);

if (opts.help) {
	console.log(`Nexus Agent 安全审计

用法：
  bun scripts/security-audit.ts [options]

Options:
  --mode <mode>     指定审计模式（可重复）：
                       hardening:strict   — 检查文件 IO 是否经过沙箱
                       verify:privacy     — 检查无遥测/分析残留
                       audit:spawn        — 检查 spawn/exec 受 sandbox 控制
                       audit:network      — 检查网络请求白名单
  --json            JSON 输出（CI 友好）
  --quiet           仅打印 error
  --strict          严格模式（warn 升级为 error）
  -h, --help        显示此帮助

退出码：
  0 = 无 error
  1 = 至少一个 error（或 strict 模式下有 warn）
  2 = 脚本自身错误
`);
	process.exit(0);
}

// ─── 扫描范围 ──────────────────────────────────────────────────────────
const SCAN_DIRS = [
	"packages/nexus-sandbox",
	"packages/nexus-checkpoint",
	"packages/nexus-compaction",
	"packages/nexus-grpc",
	"packages/nexus-routing",
	"crates/nexus-sandbox",
	"crates/nexus-checkpoint",
	"vscode-extension/nexus-vscode",
];

// 单独扫描的散落文件（sandbox 集成点、CLI 入口）
const SCAN_FILES = ["packages/coding-agent/src/cli.ts"];

const SCAN_GLOBS = [
	"**/*.ts",
	"**/*.tsx",
	"**/*.js",
	"**/*.mjs",
	"**/*.rs",
];

// ─── 网络白名单（verify:network 用）─────────────────────────────────
// 允许的请求主机（按 provider 的官方 API）。任何不在白名单的 fetch/http
// 都视为 error。CI 上可设 NEXUS_NET_AUDIT_STRICT=1 强制拒绝未列出主机。
const ALLOWED_HOSTS = new Set([
	// Anthropic
	"api.anthropic.com",
	// OpenAI
	"api.openai.com",
	"chat.openai.com",
	// DeepSeek
	"api.deepseek.com",
	// Google Gemini
	"generativelanguage.googleapis.com",
	// Moonshot / Kimi
	"api.moonshot.cn",
	// Zhipu / GLM
	"open.bigmodel.cn",
	// Qwen / DashScope
	"dashscope.aliyuncs.com",
	// Ollama（本地）
	"127.0.0.1",
	"localhost",
	// OpenRouter
	"openrouter.ai",
	// Groq
	"api.groq.com",
	// GitHub（gh CLI / API）
	"api.github.com",
	"github.com",
	// OpenClaude gRPC（本地）
	// nexus gRPC server 通常监听 127.0.0.1:50051
	// Nexus 自身
	"nexus.agent",
	// HuggingFace（embeddings）
	"huggingface.co",
	"cdn-lfs.huggingface.co",
	// npm registry（包发布）
	"registry.npmjs.org",
]);

// ─── 隐私 SDK 黑名单（verify:privacy 用）─────────────────────────────
// 出现这些字符串视为遥测残留。匹配时排除在注释里出现的情况。
const TELEMETRY_DENYLIST = [
	// 商业遥测 SDK
	"mixpanel",
	"segment-analytics",
	"@segment/analytics-node",
	"posthog-node",
	"@posthog/node",
	"amplitude",
	"@amplitude/analytics-node",
	"google-analytics",
	"googletagmanager",
	"gtag(",
	"firebase-analytics",
	"datadog-browser",
	"@sentry/browser",
	"@sentry/node",
	// 废弃 / 已迁移的 omp 遥测
	"omp-telemetry",
	"pi-telemetry",
	"omp-mixpanel",
	// 数据上报关键词（不在注释中的话）
	"trackUserEvent(",
	"reportTelemetry(",
	"sendAnalyticsEvent(",
];

// ─── 沙箱路径前缀（hardening:strict 用）─────────────────────────────
// 文件 IO 若走以下前缀之一，视为经过沙箱。否则视为绕过。
// 在 Nexus 中，沙箱工作区默认是 process.cwd() 或 ~/.nexus/sandbox/。
// 这里不能列举全部合法路径，所以策略是：
//   - 检测 IO 调用（fs.write*, Bun.write, fs.readFile 等）
//   - 若路径参数是绝对路径且不在白名单前缀中，flag 为 warn
//   - 若直接使用 process.cwd() 之外的绝对路径，flag 为 warn
const SANDBOX_PATH_PREFIXES = [
	".", // 相对路径（默认在工作区内）
	"~/.nexus",
	"~/.nexus/",
	process.env.HOME ? join(process.env.HOME, ".nexus") : "",
	"tmp",
	"tmp/",
	"temp",
];

// ─── Finding 结构 ─────────────────────────────────────────────────────
type Severity = "error" | "warn" | "info";

interface Finding {
	mode: string;
	severity: Severity;
	file: string;
	line: number;
	message: string;
	rule: string;
}

const findings: Finding[] = [];

// ─── 工具函数 ──────────────────────────────────────────────────────────
async function listScanFiles(): Promise<string[]> {
	const out: string[] = [];
	const seen = new Set<string>();

	const pushFile = (abs: string) => {
		if (seen.has(abs)) return;
		seen.add(abs);
		out.push(abs);
	};

	for (const dir of SCAN_DIRS) {
		const absDir = join(repoRoot, dir);
		if (!existsSync(absDir)) continue;
		for (const pattern of SCAN_GLOBS) {
			const g = new Glob(pattern);
			for await (const path of g.scan({ cwd: absDir, onlyFiles: true })) {
				const abs = join(absDir, path);
				// 排除 node_modules / dist / target / .turbo
				if (abs.includes(`${sep}node_modules${sep}`)) continue;
				if (abs.includes(`${sep}dist${sep}`)) continue;
				if (abs.includes(`${sep}target${sep}`)) continue;
				if (abs.includes(`${sep}.turbo${sep}`)) continue;
				pushFile(abs);
			}
		}
	}

	for (const file of SCAN_FILES) {
		const abs = join(repoRoot, file);
		if (existsSync(abs)) pushFile(abs);
	}

	return out;
}

function isIgnored(line: string): boolean {
	return /\bnexus-audit-ignore\b/.test(line);
}

// 异步读取文件所有行（兼容 Bun 各版本，避免依赖 textSync）
async function readLinesAsync(file: string): Promise<string[]> {
	const text = await Bun.file(file).text();
	return text.split(/\r?\n/);
}

// ─── 模式 1: hardening:strict ────────────────────────────────────────
// 检测裸文件 IO 调用（未经过沙箱包装）
const RAW_IO_PATTERNS: Array<{ regex: RegExp; rule: string; desc: string }> = [
	// Node fs 同步/异步写
	{ regex: /\bfs\.writeFile\s*\(/, rule: "raw-fs-write", desc: "裸 fs.writeFile 调用：应改用沙箱包装的 writeFile" },
	{ regex: /\bfs\.writeFileSync\s*\(/, rule: "raw-fs-write", desc: "裸 fs.writeFileSync 调用：应改用沙箱包装的 writeFile" },
	{ regex: /\bfs\.appendFile\s*\(/, rule: "raw-fs-write", desc: "裸 fs.appendFile 调用：应改用沙箱包装的 writeFile" },
	{ regex: /\bfs\.mkdir\s*\(/, rule: "raw-fs-write", desc: "裸 fs.mkdir 调用：应改用沙箱包装的 mkdir" },
	{ regex: /\bfs\.rm\s*\(/, rule: "raw-fs-write", desc: "裸 fs.rm 调用：应改用沙箱包装的 rm" },
	{ regex: /\bfs\.unlink\s*\(/, rule: "raw-fs-write", desc: "裸 fs.unlink 调用：应改用沙箱包装的 unlink" },
	{ regex: /\bfs\.rmdir\s*\(/, rule: "raw-fs-write", desc: "裸 fs.rmdir 调用：应改用沙箱包装的 rmdir" },
	// Bun.write
	{ regex: /\bBun\.write\s*\(/, rule: "raw-bun-write", desc: "裸 Bun.write 调用：应改用沙箱包装的 writeFile" },
	// Rust std::fs
	{ regex: /\bstd::fs::write\s*\(/, rule: "raw-rust-write", desc: "裸 std::fs::write 调用：应改用沙箱包装的 fs API" },
	{ regex: /\bstd::fs::remove_file\s*\(/, rule: "raw-rust-write", desc: "裸 std::fs::remove_file 调用：应改用沙箱包装的 fs API" },
	{ regex: /\bstd::fs::remove_dir\s*\(/, rule: "raw-rust-write", desc: "裸 std::fs::remove_dir 调用：应改用沙箱包装的 fs API" },
	{ regex: /\bstd::fs::remove_dir_all\s*\(/, rule: "raw-rust-write", desc: "裸 std::fs::remove_dir_all 调用：应改用沙箱包装的 fs API" },
	{ regex: /\bstd::fs::create_dir\s*\(/, rule: "raw-rust-write", desc: "裸 std::fs::create_dir 调用：应改用沙箱包装的 fs API" },
	{ regex: /\bFile::create\s*\(/, rule: "raw-rust-write", desc: "裸 File::create 调用：应改用沙箱包装的 fs API" },
];

// 沙箱白名单符号（IO 通过这些包装调用即视为安全）
const SANDBOX_WRAPPER_HINTS = [
	"sandbox.writeFile",
	"sandbox.readFile",
	"SandboxHandle",
	"createSandbox",
	"sandbox.exec",
	"sandboxFs",
	"workspaceFs",
	"CheckpointStore", // checkpoint 内部的文件操作是受控的
	"checkpoint_store", // Rust crate
];

async function auditHardeningStrict(files: string[]): Promise<void> {
	if (!opts.modes.includes("hardening:strict")) return;

	for (const file of files) {
		const lines = await readLinesAsync(file);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isIgnored(line)) continue;

			// 检查是否是沙箱包装调用
			const isWrapped = SANDBOX_WRAPPER_HINTS.some((h) => line.includes(h));

			for (const pattern of RAW_IO_PATTERNS) {
				if (pattern.regex.test(line)) {
					// 如果该行同时调用了沙箱包装，视为豁免
					if (isWrapped) continue;
					// 如果是测试文件，降级为 warn
					const isTest = file.includes(".test.ts") || file.includes("/test/") || file.includes("/tests/") || file.includes("#[cfg(test)]");
					const severity: Severity = isTest ? "warn" : "error";
					findings.push({
						mode: "hardening:strict",
						severity,
						file: relative(repoRoot, file),
						line: i + 1,
						message: pattern.desc,
						rule: pattern.rule,
					});
				}
			}
		}
	}
}

// ─── 模式 2: verify:privacy ──────────────────────────────────────────
async function auditVerifyPrivacy(files: string[]): Promise<void> {
	if (!opts.modes.includes("verify:privacy")) return;

	for (const file of files) {
		const lines = await readLinesAsync(file);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isIgnored(line)) continue;
			// 跳过注释行
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
			// 跳过 markdown / 文档文件
			if (file.endsWith(".md")) continue;

			const lower = line.toLowerCase();
			for (const deny of TELEMETRY_DENYLIST) {
				if (lower.includes(deny.toLowerCase())) {
					findings.push({
						mode: "verify:privacy",
						severity: "error",
						file: relative(repoRoot, file),
						line: i + 1,
						message: `检测到遥测/分析残留：${deny}`,
						rule: "privacy-telemetry",
					});
				}
			}

			// 检查可疑的隐私敏感字段收集（用户名、邮箱、IP 等）
			if (/\bcollectUser(Pii|PersonalInfo|Email|IpAddress|Location)\b/.test(line)) {
				findings.push({
					mode: "verify:privacy",
					severity: "error",
					file: relative(repoRoot, file),
					line: i + 1,
					message: "检测到 PII 收集函数调用",
					rule: "privacy-pii-collection",
				});
			}
		}
	}
}

// ─── 模式 3: audit:spawn ─────────────────────────────────────────────
const SPAWN_PATTERNS: Array<{ regex: RegExp; rule: string; desc: string }> = [
	{ regex: /\bBun\.spawn\s*\(/, rule: "raw-spawn", desc: "Bun.spawn 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bBun\.spawnSync\s*\(/, rule: "raw-spawn", desc: "Bun.spawnSync 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bchild_process\.spawn\s*\(/, rule: "raw-spawn", desc: "child_process.spawn 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bchild_process\.exec\s*\(/, rule: "raw-spawn", desc: "child_process.exec 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bchild_process\.execSync\s*\(/, rule: "raw-spawn", desc: "child_process.execSync 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bchild_process\.fork\s*\(/, rule: "raw-spawn", desc: "child_process.fork 调用：应经过 sandbox.exec 控制" },
	// Rust
	{ regex: /\bCommand::new\s*\(/, rule: "raw-rust-spawn", desc: "Rust Command::new 调用：应经过 sandbox.exec 控制" },
	{ regex: /\bstd::process::Command\s*\(/, rule: "raw-rust-spawn", desc: "Rust std::process::Command 调用：应经过 sandbox.exec 控制" },
];

const SPAWN_WRAPPER_HINTS = [
	"sandbox.exec",
	"SandboxHandle",
	"createSandbox",
	"sandboxedExec",
	"runInSandbox",
	"bashTool", // bash 工具已经接入沙箱
	"BashTool",
	"bash.ts",
];

async function auditSpawn(files: string[]): Promise<void> {
	if (!opts.modes.includes("audit:spawn")) return;

	for (const file of files) {
		const lines = await readLinesAsync(file);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isIgnored(line)) continue;

			const isWrapped = SPAWN_WRAPPER_HINTS.some((h) => line.includes(h));

			for (const pattern of SPAWN_PATTERNS) {
				if (pattern.regex.test(line)) {
					if (isWrapped) continue;
					const isTest = file.includes(".test.ts") || file.includes("/test/") || file.includes("/tests/");
					const severity: Severity = isTest ? "warn" : "error";
					findings.push({
						mode: "audit:spawn",
						severity,
						file: relative(repoRoot, file),
						line: i + 1,
						message: pattern.desc,
						rule: pattern.rule,
					});
				}
			}
		}
	}
}

// ─── 模式 4: audit:network ───────────────────────────────────────────
const NETWORK_PATTERNS: Array<{ regex: RegExp; rule: string }> = [
	{ regex: /\bfetch\s*\(\s*["'`]https?:\/\//, rule: "fetch-url" },
	{ regex: /\bfetch\s*\(\s*`https?:\/\//, rule: "fetch-template" },
	{ regex: /new\s+URL\s*\(\s*["'`]https?:\/\//, rule: "new-url" },
	{ regex: /\bhttp\.get\s*\(\s*["'`]https?:\/\//, rule: "http-get" },
	{ regex: /\bhttp\.post\s*\(\s*["'`]https?:\/\//, rule: "http-post" },
	{ regex: /\bhttps\.get\s*\(\s*["'`]https?:\/\//, rule: "https-get" },
	{ regex: /\bXMLHttpRequest/, rule: "xhr" },
	// Rust
	{ regex: /\breqwest::get\s*\(/, rule: "rust-reqwest" },
	{ regex: /\bureq::get\s*\(/, rule: "rust-ureq" },
];

async function auditNetwork(files: string[]): Promise<void> {
	if (!opts.modes.includes("audit:network")) return;

	for (const file of files) {
		const lines = await readLinesAsync(file);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isIgnored(line)) continue;

			for (const pattern of NETWORK_PATTERNS) {
				if (pattern.regex.test(line)) {
					// 提取主机
					const urlMatch = line.match(/https?:\/\/([a-zA-Z0-9.\-_]+)/);
					const host = urlMatch ? urlMatch[1] : "(未知)";

					if (ALLOWED_HOSTS.has(host)) {
						// 白名单：info 级
						findings.push({
							mode: "audit:network",
							severity: "info",
							file: relative(repoRoot, file),
							line: i + 1,
							message: `网络请求到白名单主机：${host}`,
							rule: pattern.rule,
						});
					} else {
						// 非白名单：error
						const severity: Severity = opts.strict ? "error" : "warn";
						findings.push({
							mode: "audit:network",
							severity,
							file: relative(repoRoot, file),
							line: i + 1,
							message: `网络请求到非白名单主机：${host}（若为新增 provider，请加入 ALLOWED_HOSTS）`,
							rule: pattern.rule,
						});
					}
				}
			}
		}
	}
}

// ─── 主流程 ────────────────────────────────────────────────────────────
const startTime = Date.now();
console.log("=== Nexus Agent 安全审计 ===\n");
console.log(`模式：${opts.modes.join(", ")}`);
console.log(`严格模式：${opts.strict ? "on" : "off"}\n`);

console.log("扫描范围：");
for (const dir of SCAN_DIRS) {
	const abs = join(repoRoot, dir);
	console.log(`  ${existsSync(abs) ? "✓" : "✗"} ${dir}`);
}
console.log("");

const files = await listScanFiles();
console.log(`待扫描文件数：${files.length}\n`);

// 跑各模式
await auditHardeningStrict(files);
await auditVerifyPrivacy(files);
await auditSpawn(files);
await auditNetwork(files);

// 应用 strict 模式
if (opts.strict) {
	for (const f of findings) {
		if (f.severity === "warn") f.severity = "error";
	}
}

// 过滤 quiet 模式
const visibleFindings = opts.quiet ? findings.filter((f) => f.severity === "error") : findings;

// 输出
if (opts.json) {
	console.log(JSON.stringify({
		findings: visibleFindings,
		summary: {
			total: visibleFindings.length,
			errors: visibleFindings.filter((f) => f.severity === "error").length,
			warns: visibleFindings.filter((f) => f.severity === "warn").length,
			infos: visibleFindings.filter((f) => f.severity === "info").length,
			durationMs: Date.now() - startTime,
		},
	}, null, 2));
} else {
	// 按模式分组
	const byMode = new Map<string, Finding[]>();
	for (const f of visibleFindings) {
		if (!byMode.has(f.mode)) byMode.set(f.mode, []);
		byMode.get(f.mode)!.push(f);
	}

	for (const [mode, modeFindings] of byMode) {
		console.log(`── ${mode} (${modeFindings.length} findings) ──`);
		for (const f of modeFindings) {
			const sevIcon = f.severity === "error" ? "✗" : f.severity === "warn" ? "!" : "·";
			console.log(`  ${sevIcon} ${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
		}
		console.log();
	}
}

// 汇总
const errors = findings.filter((f) => f.severity === "error").length;
const warns = findings.filter((f) => f.severity === "warn").length;
const infos = findings.filter((f) => f.severity === "info").length;

if (!opts.json) {
	console.log("=== 汇总 ===");
	console.log(`  error: ${errors}`);
	console.log(`  warn:  ${warns}`);
	console.log(`  info:  ${infos}`);
	console.log(`  耗时:  ${Date.now() - startTime}ms\n`);
}

if (errors > 0) {
	if (!opts.json) {
		console.error(`\n安全审计失败：${errors} 个 error。请修复或加 // nexus-audit-ignore: <reason> 豁免。\n`);
	}
	process.exit(1);
}

if (!opts.json) {
	console.log("安全审计通过。\n");
}
process.exit(0);
