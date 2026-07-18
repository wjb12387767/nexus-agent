import * as fs from "node:fs";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getProjectDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import type { SandboxHandle } from "@oh-my-pi/nexus-sandbox";
import { parseForSecurity } from "@nexus-agent/bash-ast";
import { type } from "arktype";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type { ClientBridgeTerminalExitStatus, ClientBridgeTerminalOutput } from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { resolveEvalBackends } from "./eval-backends";
import { maybeAutoCheckpoint } from "./file-checkpoint";
import { invalidateGithubCacheForBashCommand } from "./gh-cache-invalidation";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatToolWorkingDirectory,
	previewWindowRows,
	replaceTabs,
} from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows,
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) instead of dropping to `cmd.exe` on Windows. The agent host's shell
 * path is used as a proxy for the client's, matching the near-universal
 * ACP deployment shape of an editor spawning omp as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight — the cost of a false negative is data loss or a compromised host,
 * while false positives remain actionable through user policy control.
 * New patterns should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	/\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i, // rm -rf /, rm -fr /, rm -r /, rm -f /…
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	/\bdd\s+if=.+of=\/dev\//i, // dd to a device.
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("bash-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

const bashSchemaBase = type({
	command: type("string").describe("command to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe("working directory"),
	"pty?": type("boolean").describe("run in pty mode"),
});

const bashSchemaWithAsync = type({
	command: "string",
	"env?": { "[string]": "string" },
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": type("boolean").describe("run in background"),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	stopUpdates: () => void;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

// ────────────────────────────────────────────────────────────────────────────
// Sandbox loader (Task 2.6.1)
// ────────────────────────────────────────────────────────────────────────────
// `@oh-my-pi/nexus-sandbox` 是一个 NAPI 原生模块，可能未在某些环境编译
// （例如未运行 `napi build`）。用动态 import + 缓存确保：
//  1. 默认 `sandbox.enabled = false` 时完全不加载原生模块；
//  2. 加载失败时优雅降级并给出明确错误信息；
//  3. 多次调用复用同一个 Promise，避免重复 require 触发 dlopen。

type SandboxModule = typeof import("@oh-my-pi/nexus-sandbox");
let sandboxModulePromise: Promise<SandboxModule | null> | null = null;

async function loadSandboxModule(): Promise<SandboxModule | null> {
	if (sandboxModulePromise !== null) return sandboxModulePromise;
	sandboxModulePromise = (async () => {
		try {
			return await import("@oh-my-pi/nexus-sandbox");
		} catch (error) {
			logger.warn(
				"Failed to load @oh-my-pi/nexus-sandbox native addon; sandbox execution path disabled",
				{ error },
			);
			return null;
		}
	})();
	return sandboxModulePromise;
}

/**
 * Quote a filesystem path for use in `bash -c 'cd <path> && ...'` so that
 * `SandboxHandle.exec` (which spawns `bash -c <line>` without a separate cwd
 * argument) preserves the original `cwd` parameter semantics.
 */
function quoteShellPath(p: string): string {
	// 单引号包裹并把内部的 `'` 转义为 `'\''`（POSIX 标准做法）。
	return `'${p.replaceAll("'", "'\\''")}'`;
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatTimeoutClampNotice(requestedTimeoutSec: number, effectiveTimeoutSec: number): string | undefined {
	return requestedTimeoutSec !== effectiveTimeoutSec
		? `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s).`
		: undefined;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

/**
 * Strip the trailing occurrence of `notice` (plus a single surrounding newline
 * on each side) so the TUI can echo the value via a styled footer label
 * instead of repeating it verbatim in the output pane. The notice is
 * reconstructed from the same value the result was tagged with, so a literal
 * sub-string match never strips a coincidental in-output token — only the
 * exact line we appended in #buildCompletedResult.
 */
function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, formatWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId));
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<typeof bashSchemaBase | typeof bashSchemaWithAsync, BashToolDetails> {
	readonly name = "bash";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		// AST 安全分析优先（可关闭，默认开启）。失败时 fall back 到正则，
		// 不能让 AST 异常阻塞 bash 工具。
		if (command !== "" && this.session.settings.get("bash.astSecurity") !== false) {
			try {
				const astResult = parseForSecurity(command);
				if (astResult.verdict === "safe") {
					// AST 标记安全，直接放行（不走正则）。AST 比 CRITICAL_BASH_PATTERNS
					// 更精确：safe 仅当无 eval/$(...)/subshell/控制流等注入构造时返回。
					return "exec";
				}
				// needs-approval / aborted：继续走正则流程，让正则决定 severity
				// （critical → override force-prompt；不匹配 → "exec"）。
			} catch (err) {
				// AST 包不可用或异常，fall back 到正则
				logger.warn("bash AST analysis failed, falling back to regex", { error: err });
			}
		}
		// 现有正则 approval 逻辑保持不变（作为 fallback 与 severity 仲裁）
		if (command !== "" && CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command))) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		return "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		return prompt.render(bashDescription, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundThresholdSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			hasAstGrep: isToolActive("ast_grep", this.session.settings.get("astGrep.enabled")),
			hasAstEdit: isToolActive("ast_edit", this.session.settings.get("astEdit.enabled")),
			hasGrep: isToolActive("grep", this.session.settings.get("grep.enabled")),
			hasGlob: isToolActive("glob", this.session.settings.get("glob.enabled")),
			hasRead: isToolActive("read", true),
			hasLaunch: isToolActive("hub", this.session.settings.get("launch.enabled")),
			hasEval: isToolActive(
				"eval",
				evalBackends.python || evalBackends.js || evalBackends.ruby || evalBackends.julia,
			),
		});
	}
	readonly parameters: BashToolSchema;
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;
	// 沙箱句柄（Task 2.6.1）：当 `sandbox.enabled` 为 true 时懒加载并复用。
	// 沙箱应用是不可逆的，所以句柄在第一次 exec 后保持，所有后续 bash 调用
	// 复用同一个已应用沙箱的进程级状态。
	#sandboxHandle: SandboxHandle | null = null;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		return outputText || "(no output)";
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user aborts and a
	 * missing exit status. Timeouts are handled separately by
	 * #buildCompletedResult, which returns a non-throwing error result with
	 * details.timedOut=true so the renderer can show a warning border. The
	 * foreground and bridge callers plus the async job manager rely on these
	 * throwing so cancellations surface as aborts and jobs are recorded as
	 * failed. A definite non-zero exit is a completed command that failed;
	 * #buildCompletedResult surfaces it as an error *result* (carrying
	 * execution details) rather than a throw.
	 */
	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		if (result.cancelled) {
			// Local executor output already carries a leading `[Command cancelled]`
			// notice from the sink; PTY/bridge output does not, so annotate only
			// the latter.
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(annotated || "Command aborted");
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(out ? `${out}\n\n[${message}]` : message);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			wallTimeMs?: number;
		} = {},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const outputLines = [this.#formatResultOutput(result)];
		const notices: string[] = [];
		if (options.wallTimeMs !== undefined) {
			notices.push(formatWallTimeNotice(options.wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		if (notices.length > 0) outputLines.push("", ...notices);
		if (failedExit) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Timeouts are not failures — the command ran its course. Return an error
		// result (isError=true for the model) but flag timedOut so the renderer
		// uses a warning border instead of error red. Both interactive and
		// non-interactive results carry an explicit `timedOut` field from the
		// executor/PTY layer.
		const isTimeout = result.timedOut === true;

		const details: BashToolDetails = {};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		if (options.wallTimeMs !== undefined) {
			details.wallTimeMs = options.wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			// executeBash has already emitted this leading sink notice. PTY output
			// has not, so provide the LLM-facing annotation exactly once.
			if (!normalizeResultOutput(result).startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), {
				saveArtifact: full => saveBashOriginalArtifact(this.session, full),
			});
			return toolResult(details)
				.text(timeoutOutputText)
				.truncationFromSummary(result, { direction: "tail" })
				.error()
				.done();
		}

		// Non-timeout cancellations and missing exit status still propagate as thrown errors.
		this.#throwIfUnfinished(result, timeoutSec, outputText);

		// Final defense at the tool-result boundary: no bash path (client bridge,
		// head-retention spill, minimizer miss) may emit more than
		// ~DEFAULT_MAX_BYTES inline. No-op for already-bounded output.
		const cappedOutputText = await enforceInlineByteCap(outputText, {
			saveArtifact: full => saveBashOriginalArtifact(this.session, full),
		});

		const resultBuilder = toolResult(details)
			.text(cappedOutputText)
			.truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: { requestedTimeoutSec?: number; notices?: readonly string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash" },
		};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		forwardUpdates: boolean;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let forwardUpdates = options.forwardUpdates;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				const wallTimeStart = performance.now();
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
						wallTimeMs,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: async text => {
					latestText = text;
					if (!forwardUpdates) return;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: {},
					});
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			stopUpdates: () => {
				forwardUpdates = false;
			},
		};
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		thresholdMs: number,
		signal?: AbortSignal,
	): Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }> {
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		const waiters: Array<Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }>> = [
			job.completion,
			Bun.sleep(thresholdMs).then(() => ({ kind: "running" as const })),
		];

		if (!signal) {
			return await Promise.race(waiters);
		}

		const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
		const onAbort = () => resolveAborted({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(abortedPromise);
		try {
			return await Promise.race(waiters);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#resolveAutoBackgroundWaitMs(timeoutMs: number | undefined): number {
		if (this.#autoBackgroundThresholdMs <= 0) return 0;
		if (timeoutMs === undefined) return this.#autoBackgroundThresholdMs;
		const timeoutBufferMs = 1_000;
		return Math.max(0, Math.min(this.#autoBackgroundThresholdMs, timeoutMs - timeoutBufferMs));
	}

	/**
	 * 在 OS 沙箱内执行 bash 命令（Task 2.6.1）。
	 *
	 * 通过 `@oh-my-pi/nexus-sandbox` NAPI 接口把命令路由到 Rust 侧的
	 * `SandboxHandle.exec()`，由 Rust 侧根据目标平台选择执行方式：
	 *   - Linux：通过 `pre_exec` 安装 seccomp 网络过滤器（当 profile 启用
	 *     `restrict_network` 时）；Landlock 在 apply 阶段已应用。
	 *   - macOS：通过 `sandbox-exec -p <profile> -- <cmd> <args>` 执行。
	 *   - Windows：直接执行（ISO FS 已隔离工作区）。
	 *
	 * 沙箱句柄在第一次调用时创建并 `apply()`（不可逆），后续调用复用同一
	 * 句柄。`apply()` 失败时降级为非沙箱执行（与 Rust 侧 graceful degrade
	 * 语义一致）。
	 *
	 * SandboxHandle.exec 当前不接受 `cwd` / `env` 参数（Rust 侧直接
	 * `Command::new(cmd).args(args)`），所以 cwd 与 env 被嵌入命令行
	 * （`cd "<cwd>" && KEY="val" <cmd>`）由 shell 自身处理。
	 */
	async #runSandboxed(options: {
		command: string;
		commandCwd: string;
		env?: Record<string, string> | undefined;
		profile: string;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices: readonly string[];
	}): Promise<AgentToolResult<BashToolDetails>> {
		const sandboxModule = await loadSandboxModule();
		if (sandboxModule === null) {
			throw new ToolError(
				"Sandbox is enabled but @oh-my-pi/nexus-sandbox native addon is unavailable. " +
					"Build it with: bun --cwd=packages/nexus-sandbox run build",
			);
		}

		// 第一次调用：创建并应用沙箱。沙箱应用不可逆，复用句柄避免重复 apply。
		if (this.#sandboxHandle === null) {
			const handle = sandboxModule.createSandbox(options.profile, {
				workspace: this.session.cwd,
			});
			try {
				await handle.apply();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("Sandbox apply failed; falling back to unsandboxed execution", {
					profile: options.profile,
					error: message,
				});
				this.#sandboxHandle = null;
				throw new ToolError(
					`Sandbox apply failed (profile=${options.profile}): ${message}. ` +
						"Disable sandbox.enabled or change sandbox.profile to continue.",
				);
			}
			this.#sandboxHandle = handle;
		}

		// 构造命令行：cd <cwd> && ENV=val <command>
		// SandboxHandle.exec 调用 `bash -c <line>`，故 cwd 与 env 需嵌入命令行。
		const shellConfig = this.session.settings.getShellConfig();
		const cwdPrefix =
			options.commandCwd !== this.session.cwd
				? `cd ${quoteShellPath(options.commandCwd)} && `
				: "";
		const envPrefix = options.env ? `${formatBashEnvAssignments(options.env)} ` : "";
		const fullCommand = `${cwdPrefix}${envPrefix}${options.command}`;

		const wallTimeStart = performance.now();
		const sandboxResult = await this.#sandboxHandle.exec(shellConfig.shell, [
			...shellConfig.args,
			fullCommand,
		]);
		const wallTimeMs = performance.now() - wallTimeStart;

		// 将 SandboxExecResult 转换为 BashResult 以复用现有的结果构建路径。
		const stdout = sandboxResult.stdout;
		const stderr = sandboxResult.stderr;
		const combinedOutput = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout;
		const bashResult: BashResult = {
			output: combinedOutput,
			exitCode: sandboxResult.exitCode,
			cancelled: false,
			truncated: false,
			totalLines: combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0,
			totalBytes: combinedOutput.length,
			outputLines: combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0,
			outputBytes: combinedOutput.length,
		};

		return this.#buildCompletedResult(bashResult, options.timeoutSec, {
			requestedTimeoutSec: options.requestedTimeoutSec,
			notices: options.notices,
			wallTimeMs,
		});
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout = 300,
			cwd,

			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);

		// Extract leading `cd <path> && ...` into cwd when the model ignores the cwd parameter.
		// Constrained to a single line so a `&&` that sits on a later line of a multiline
		// script can't pull the entire script into the "cwd" capture.
		if (!cwd) {
			const cdMatch = command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
			// Skip extraction when the path needs shell expansion ($VAR, $(...),
			// backticks) — resolveToCwd only expands `~`, so routing those through
			// cwd would reject commands the shell itself handles fine.
			if (cdMatch && !/[$`(]/.test(cdMatch[1])) {
				cwd = cdMatch[1].trim().replace(/^["']|["']$/g, "");
				command = command.slice(cdMatch[0].length);
			}
		}
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		// Check both the original command and the cwd-normalized command so
		// leading `cd ... &&` wrappers do not hide either shell-navigation rules
		// or the dedicated-tool command that follows the directory change.
		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: this.session.cwd,
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, { ...internalUrlOptions, ensureLocalParentDirs: true });
		const resolvedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;

		// Resolve protocol URLs (skill://, agent://, etc.) in extracted cwd.
		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		// ── Task 3.6: 文件级 checkpoint（M3 里程碑）──────────────────────────
		// 在 bash 执行前自动打 checkpoint，仅在 `checkpoint.autoEnabled = true`
		// 且距上次 checkpoint 超过 `checkpoint.autoInterval` 时才实际创建。
		// 失败静默降级（不阻塞 bash 执行），路径以 cwd 为准（bash 可能改任意文件）。
		await maybeAutoCheckpoint(this.session, [commandCwd]).catch(() => {
			// checkpoint 失败不应阻塞 bash 执行
		});

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but OMP does not impose a deadline.
		const requestedTimeoutSec = rawTimeout;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		const pendingNotices: string[] = [];
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: false,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// ── Task 2.6.1: 沙箱执行路径 ──────────────────────────────────────────
		// 当 `sandbox.enabled` 为 true 且 profile 不为 "off" 时，将命令路由到
		// `SandboxHandle.exec()`（Linux 通过 seccomp/Landlock，macOS 通过
		// sandbox-exec，Windows 通过 ISO FS 隔离）。
		//
		// 跳过条件：
		//   - `pty === true`：PTY 需要终端，沙箱 + PTY 不兼容；
		//   - `asyncRequested`：上面已经返回；
		//   - `sandbox.profile === "off"`：用户显式关闭沙箱。
		//
		// 不跳过 client bridge 路径：当用户开启沙箱时，沙箱应优先于 editor 终端
		// （editor 终端不提供 OS 级隔离，仅是 UI 路由）。
		if (!pty && this.session.settings.get("sandbox.enabled")) {
			const sandboxProfile = this.session.settings.get("sandbox.profile");
			if (sandboxProfile !== "off") {
				return await this.#runSandboxed({
					command,
					commandCwd,
					env: resolvedEnv,
					profile: sandboxProfile,
					timeoutSec,
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
		}

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty,
		);

		const autoBgManager = this.session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		if (
			this.#autoBackgroundEnabled &&
			!pty &&
			!bridgeTerminalAvailable &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = this.#resolveAutoBackgroundWaitMs(timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: !startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
			// Suppress the completion delivery up front so a job finishing while we
			// foreground-wait cannot also be injected by the delivery loop. Lifted
			// via resumeDeliveries() if we end up backgrounding after all.
			autoBgManager.acknowledgeDeliveries([job.jobId]);
			const waitResult = await this.#waitForManagedBashJob(job, autoBackgroundWaitMs, signal);
			if (waitResult.kind === "completed") {
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.stopUpdates();
			autoBgManager.resumeDeliveries([job.jobId]);
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI).
		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const bridgeWallTimeStart = performance.now();
			const shellSpawn = wrapShellLineForClientTerminal(command, this.session.settings.getShellConfig());
			const handle = await clientBridge.createTerminal({
				command: shellSpawn.command,
				args: shellSpawn.args,
				cwd: commandCwd,
				env: resolvedEnv
					? Object.entries(resolvedEnv).map(([name, value]) => ({ name, value: value as string }))
					: undefined,
				outputByteLimit: DEFAULT_MAX_BYTES,
			});

			// Emit partial update so the editor can embed the live terminal card.
			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			const exitPromise = handle.waitForExit();
			let exitStatus!: ClientBridgeTerminalExitStatus;

			type BridgeRaceResult =
				| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
				| { kind: "poll" }
				| { kind: "timeout" }
				| { kind: "aborted" };

			// Set up abort listener before entering the poll loop. The listener
			// kicks off `handle.kill()` synchronously so a `session/cancel`
			// arriving mid-poll terminates the remote command immediately,
			// instead of waiting for the next `currentOutput()` to return.
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				killStarted = true;
				return handle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: handle.terminalId, error });
				});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				try {
					if (signal?.aborted) {
						await fireKill();
						throw new ToolAbortError("Command aborted");
					}

					const timeoutPromise = timeoutMs
						? Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }))
						: undefined;
					// Poll until the process exits, times out, or the caller aborts.
					for (;;) {
						const racers: Array<Promise<BridgeRaceResult>> = [
							exitPromise.then(s => ({ kind: "exit" as const, status: s })),
							Bun.sleep(250).then(() => ({ kind: "poll" as const })),
						];
						if (timeoutPromise) racers.push(timeoutPromise);
						if (signal) {
							racers.push(abortedP.then(() => ({ kind: "aborted" as const })));
						}
						const raced = await Promise.race(racers);

						if (raced.kind === "aborted" || signal?.aborted) {
							await fireKill();
							throw new ToolAbortError("Command aborted");
						}

						if (raced.kind === "timeout") {
							// Kill before reading final output so a slow `terminal/output`
							// RPC cannot let a timed-out command keep running past the
							// enforced timeout. The handle stays valid post-kill so the
							// buffered output is still readable.
							await fireKill();
							let current = { output: "", truncated: false };
							try {
								current = await handle.currentOutput();
							} catch (error) {
								logger.warn("ACP terminal final output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const timedOutResult: BashInteractiveResult = {
								output: current.output,
								exitCode: undefined,
								cancelled: false,
								timedOut: true,
								truncated: current.truncated,
								totalLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								totalBytes: current.output.length,
								outputLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								outputBytes: current.output.length,
							};
							this.#throwIfUnfinished(timedOutResult, timeoutSec, this.#formatResultOutput(timedOutResult));
							throw new ToolError("Command timed out");
						}

						if (raced.kind === "exit") {
							exitStatus = raced.status;
							break;
						}

						// Poll tick: push current output so agent-loop transcript stays consistent.
						// Race the read against abort so a stuck `terminal/output` RPC does not
						// delay cancellation.
						const pollOutput = await Promise.race([
							handle.currentOutput(),
							abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined),
						]);
						if (pollOutput === undefined) {
							// Abort fired during the poll-tick read; let the next loop iteration
							// observe `signal?.aborted` and exit via the abort branch.
							continue;
						}
						onUpdate?.({
							content: [{ type: "text", text: pollOutput.output }],
							details: { terminalId: handle.terminalId },
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbortSignal);
				}

				// Fetch final output; the terminal is released in the outer finally.
				const finalOutput = await handle.currentOutput();

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const outputText = finalOutput.output;
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
				});
			} finally {
				try {
					await handle.release();
				} catch (error) {
					logger.warn("ACP terminal release failed", { terminalId: handle.terminalId, error });
				}
			}
		}

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const interactiveUi = canUseInteractiveBashPty(pty, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await runInteractiveBashPty(interactiveUi, {
					command,
					cwd: commandCwd,
					timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
				})
			: await executeBash(command, {
					cwd: commandCwd,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					timeout: timeoutMs ?? 0,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					onChunk: streamTailUpdates(tailBuffer, onUpdate),
					onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
				});
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			// A cancelled result is either a timeout (the command's deadline fired)
			// or a user/system abort. Timeouts are handled by #buildCompletedResult
			// which returns a non-throwing error result with details.timedOut=true
			// so the renderer can show a warning border instead of error red.
			// Both interactive and non-interactive results carry an explicit
			// `timedOut` field from the executor/PTY layer.
			const isTimeout = result.timedOut === true;
			if (!isTimeout) {
				const out = normalizeResultOutput(result);
				// The local executor already prepends `[Command cancelled]`; PTY
				// output does not, so preserve one cancellation notice in either case.
				const message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, string> | undefined;
	showHeader?: boolean;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, string> | undefined {
	// The parsed args don't always mirror the exact current stream prefix, so recover
	// env from the raw JSON buffer to surface `NAME="..." cmd` in the preview as it
	// streams rather than only once the args object finishes.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const header =
						config.showHeader === false
							? undefined
							: renderStatusLine(
									{
										icon: options.spinnerFrame !== undefined ? "running" : "pending",
										spinnerFrame: options.spinnerFrame,
										title: config.resolveTitle(args, options),
									},
									uiTheme,
								);
					return outputBlock.render(
						{
							header,
							state: options.spinnerFrame !== undefined ? "running" : "pending",
							sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			});
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const success = !isPartial && !isError;
			const details = result.details;
			const isTimeout = details?.timedOut === true;
			const header =
				config.showHeader === false
					? undefined
					: renderStatusLine(
							success
								? {
										iconOverride: uiTheme.styledSymbol("tool.bash", "accent"),
										title: config.resolveTitle(args, options),
									}
								: {
										icon: isPartial ? "pending" : isTimeout ? "warning" : "error",
										title: config.resolveTitle(args, options),
									},
							uiTheme,
						);
			const outputBlock = new CachedOutputBlock();

			// Per-instance cache for the expensive inner lines computation. Mirrors
			// the eval-renderer pattern (`eval-render.ts:709-752`): without this,
			// every TUI repaint (one per keystroke when a long transcript is on
			// screen) re-runs `split` / `replaceTabs` / `truncateToVisualLines` over
			// the whole stored output for every bash row in scrollback. With a
			// 50KB-tail bash result times hundreds of rows, that re-rendering is
			// what pinned the main thread in issue #2081 and made keystrokes feel
			// like the CPU was at 100%. The cache key includes every render input
			// that materially affects the produced lines.
			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedLines: readonly string[] | undefined;
			let cachedPreviewWindow: number | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";

					const isPartial = options.isPartial === true;
					const previewWindow = previewWindowRows();

					if (
						cachedLines !== undefined &&
						cachedWidth === width &&
						cachedPreviewLines === previewLines &&
						cachedExpanded === expanded &&
						cachedRawOutput === rawOutput &&
						cachedIsPartial === isPartial &&
						cachedPreviewWindow === previewWindow
					) {
						return cachedLines;
					}
					const withoutBackground = stripBackgroundNotice(rawOutput, details?.async);
					const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
					const withoutExit = stripExitCodeNotice(strippedOutput, details?.exitCode);
					const withoutWall = stripWallTimeNotice(withoutExit, details?.wallTimeMs);
					const rawOutputArtifact = stripRawOutputArtifactNotice(withoutWall);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutDisabled = details?.timeoutDisabled === true || renderContext?.timeout === 0;
					const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? renderContext?.timeout);
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const wallTimeMs = details?.wallTimeMs;
					const statsParts: string[] = [];
					if (details?.async?.state === "running") {
						statsParts.push(`Backgrounded: ${details.async.jobId}`);
					}
					if (wallTimeMs !== undefined) {
						statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
					}
					if (timeoutDisabled) {
						statsParts.push("Timeout: disabled");
					}
					if (typeof timeoutSeconds === "number") {
						statsParts.push(
							requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`,
						);
					}
					if (rawOutputArtifact.artifactId) {
						statsParts.push(`Artifact: ${rawOutputArtifact.artifactId}`);
					}
					if (isError && typeof details?.exitCode === "number") {
						statsParts.push(`Exit: ${details.exitCode}`);
					}
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							const styledOutput = rawOutputLines
								.map(line => uiTheme.fg("toolOutput", replaceTabs(line)))
								.join("\n");
							const textContent = styledOutput;
							// Cap the collapsed/streaming output to a viewport-sized tail and
							// measure it at the box's INNER width. Otherwise a growing tail
							// window scrolls its (mutating) rows above the live-region window
							// and the engine re-commits a fresh snapshot every frame —
							// spraying duplicate "… ctrl+o to expand" banners into native
							// scrollback (the box never overflows the viewport now).
							const previewBudget = Math.min(previewLines, previewWindow);
							const result = truncateToVisualLines(textContent, previewBudget, outputBlockContentWidth(width));
							if (result.skippedCount > 0) {
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length}) (ctrl+o to expand)`,
									),
								);
							}
							outputLines.push(...result.visualLines);
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					const framed = outputBlock.render(
						{
							header,
							state: isPartial ? "pending" : isError ? (isTimeout ? "warning" : "error") : "success",
							sections: [
								{
									// Viewport-sized tail window in every state — streaming and final
									// render identically; only ctrl+o uncaps.
									lines: capPreviewLines(cmdLines ?? [], uiTheme, { expanded }),
								},
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);

					cachedWidth = width;
					cachedPreviewLines = previewLines;
					cachedExpanded = expanded;
					cachedRawOutput = rawOutput;
					cachedIsPartial = isPartial;
					cachedPreviewWindow = previewWindow;
					cachedLines = framed;
					return framed;
				},
				invalidate: () => {
					outputBlock.invalidate();
					cachedLines = undefined;
					cachedWidth = undefined;
					cachedPreviewLines = undefined;
					cachedExpanded = undefined;
					cachedRawOutput = undefined;
					cachedIsPartial = undefined;
					cachedPreviewWindow = undefined;
				},
			});
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	showHeader: false,
});
