/**
 * WSL2 桥接模块 —— 让 Windows 用户通过 WSL2 获得完整的 Linux 能力。
 *
 * 提供：
 * - {@link detectWsl} 检测 WSL2 是否可用（解析 `wsl.exe --list --verbose` 的 UTF-16LE 输出）
 * - {@link windowsToWslPath} / {@link wslToWindowsPath} Windows ↔ WSL 路径互转
 * - {@link wslExec} 在 WSL 内执行命令（自动处理 distro、cwd、env 传递）
 * - {@link launchInWsl} 在 WSL2 内启动 agent（inherit stdio 交互）
 *
 * 重要约束：
 * - 所有 wsl.exe 调用都要处理 UTF-16LE 输出（wsl.exe 默认以 UTF-16LE 编码 stdout）
 * - {@link detectWsl} 在非 Windows 平台直接返回 `{ available: false, ... }`
 */
import { $which } from "@oh-my-pi/pi-utils";

/** WSL2 检测结果。 */
export interface WslInfo {
	/** WSL 是否可用（wsl.exe 存在且至少有一个发行版） */
	available: boolean;
	/** 已安装的发行版名称列表 */
	distributions: string[];
	/** 默认发行版（wsl.exe 标记 `*` 的那个） */
	defaultDistribution: string | null;
	/** wsl.exe 的完整路径（不存在时为 null） */
	wslPath: string | null;
	/** WSL 版本（取默认发行版的版本号；1 或 2，不可用时为 null） */
	version: 1 | 2 | null;
}

/** {@link wslExec} 的可选项。 */
export interface WslExecOptions {
	/** 目标发行版；省略时用默认发行版 */
	distribution?: string;
	/** 工作目录（Windows 路径，自动转换为 WSL 路径） */
	cwd?: string;
	/** 传递给 WSL 内进程的环境变量（通过 WSLENV 传递） */
	env?: Record<string, string>;
}

/** {@link wslExec} 的执行结果。 */
export interface WslExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** WSL 内安装 nexus 的指引文本。 */
export const WSL_INSTALL_INSTRUCTIONS = `Nexus Agent is not installed in WSL. To install:

# In WSL terminal:
curl -fsSL https://raw.githubusercontent.com/wjb12387767/nexus-agent/main/scripts/install.sh | sh`;

/** 不可用时的空结果，避免到处重复字面量。 */
const WSL_UNAVAILABLE: WslInfo = {
	available: false,
	distributions: [],
	defaultDistribution: null,
	wslPath: null,
	version: null,
};

/**
 * 解析 `wsl.exe --list --verbose` 的 UTF-16LE 输出。
 *
 * 输出格式（每行：名称、状态、版本，默认发行版前缀 `*`）：
 * ```
 *   NAME            STATE           VERSION
 * * Ubuntu-22.04    Running         2
 *   docker-desktop  Stopped         2
 * ```
 *
 * 纯函数，便于单测直接喂入 mock Buffer。
 */
export function parseWslListOutput(buffer: Buffer): WslInfo {
	// wsl.exe stdout 是 UTF-16LE；先解码再剥离 BOM（FF FE）。
	let text = buffer.toString("utf16le");
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

	const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
	if (lines.length === 0) return { ...WSL_UNAVAILABLE };

	const distributions: string[] = [];
	const versionByDistro = new Map<string, 1 | 2>();
	let defaultDistribution: string | null = null;

	for (const line of lines) {
		// 跳过表头行（NAME / STATE / VERSION）
		if (/^\s*NAME\s+STATE\s+VERSION/i.test(line)) continue;
		// 名称可含字母、数字、`-`、`.`、`_`；前缀可有 `*` 标记默认发行版。
		const match = line.match(/^\s*(\*)?\s*([^\s*][\w.\-]*)\s+(\S+)\s+(\d+)\s*$/);
		if (!match) continue;
		const [, defaultMarker, name, , versionStr] = match;
		distributions.push(name);
		const version = Number.parseInt(versionStr, 10) === 2 ? 2 : 1;
		versionByDistro.set(name, version);
		if (defaultMarker) defaultDistribution = name;
	}

	if (distributions.length === 0) return { ...WSL_UNAVAILABLE };

	// wsl.exe 总会标记一个默认发行版；兜底取第一个，避免 version 落空。
	const resolvedDefault = defaultDistribution ?? distributions[0];
	const version = versionByDistro.get(resolvedDefault) ?? null;

	return {
		available: true,
		distributions,
		defaultDistribution: resolvedDefault,
		wslPath: null,
		version,
	};
}

/**
 * 检测 WSL2 是否可用。
 *
 * 调用 `wsl.exe --list --verbose` 并解析输出。非 Windows 平台或 wsl.exe
 * 不存在时返回 `{ available: false, ... }`。
 */
export async function detectWsl(): Promise<WslInfo> {
	// 非 Windows 平台直接返回不可用。
	if (process.platform !== "win32") return { ...WSL_UNAVAILABLE };

	const wslPath = $which("wsl") ?? $which("wsl.exe");
	if (!wslPath) return { ...WSL_UNAVAILABLE };

	try {
		const proc = Bun.spawn({
			cmd: [wslPath, "--list", "--verbose"],
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return { ...WSL_UNAVAILABLE };
		// wsl.exe stdout 是 UTF-16LE，必须以 Buffer 读取再解码。
		const stdoutBuffer = Buffer.from(await new Response(proc.stdout).arrayBuffer());
		const info = parseWslListOutput(stdoutBuffer);
		info.wslPath = wslPath;
		return info;
	} catch {
		return { ...WSL_UNAVAILABLE };
	}
}

/**
 * Windows 路径 → WSL 路径。
 *
 * - `C:\Users\foo\project` → `/mnt/c/Users/foo/project`
 * - `D:\dir` → `/mnt/d/dir`
 * - UNC 路径 `\\server\share\path` → `/mnt/server/share/path`
 * - 已经是 WSL 风格（以 `/` 开头）的原样返回
 */
export function windowsToWslPath(winPath: string): string {
	if (!winPath) return winPath;

	// UNC 路径：\\server\share\... 或 //server/share/... → /mnt/server/share/...
	// 必须在单 `/` 判断之前，否则 `//server/...` 会被当作 WSL 风格原样返回。
	if (winPath.startsWith("\\\\") || winPath.startsWith("//")) {
		const parts = winPath.slice(2).split(/[\\/]+/).filter(Boolean);
		if (parts.length === 0) return "/mnt";
		return "/mnt/" + parts.join("/");
	}

	// 盘符路径：C:\Users\foo → /mnt/c/Users/foo
	const driveMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath);
	if (driveMatch) {
		const [, drive, rest] = driveMatch;
		const normalized = rest.replace(/\\/g, "/");
		return `/mnt/${drive.toLowerCase()}/${normalized}`.replace(/\/+$/, "");
	}

	// 已经是 WSL 风格路径（单 `/` 开头，非 UNC），原样返回。
	if (winPath.startsWith("/")) return winPath;

	// 无法识别的路径原样返回（兜底）。
	return winPath;
}

/**
 * WSL 路径 → Windows 路径。
 *
 * - `/mnt/c/Users/foo` → `C:\Users\foo`
 * - `/mnt/d/dir` → `D:\dir`
 * - `/home/user`（WSL 原生路径）→ 不转换，原样返回
 */
export function wslToWindowsPath(wslPath: string): string {
	if (!wslPath) return wslPath;
	// /mnt/<drive>（无尾部路径，可有可无末尾斜杠）→ <DRIVE>:\
	// 必须在带路径的正则之前判断，否则 /mnt/c/ 会被当作 rest="" 处理。
	const mntRootMatch = /^\/mnt\/([a-zA-Z])\/?$/.exec(wslPath);
	if (mntRootMatch) {
		return `${mntRootMatch[1].toUpperCase()}:\\`;
	}
	// /mnt/<drive>/... → <DRIVE>:\...
	const mntMatch = /^\/mnt\/([a-zA-Z])\/(.+)$/.exec(wslPath);
	if (mntMatch) {
		const [, drive, rest] = mntMatch;
		return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`.replace(/\\+$/, "");
	}
	// WSL 原生路径（/home、/usr 等）不转换。
	return wslPath;
}

/**
 * 构造 `wslExec` 调用的完整 argv（纯函数，便于单测）。
 *
 * 形如：`["wsl.exe", "-d", "Ubuntu", "--cd", "/mnt/c/foo", "--", "ls", "-la"]`
 *
 * @param commandTokens 已分词的命令 token（如 `["ls", "-la"]`）
 * @param options 执行选项
 * @param wslPath wsl.exe 路径
 * @param defaultDistro 默认发行版（options.distribution 省略时使用）
 */
export function buildWslExecArgs(
	commandTokens: string[],
	options: WslExecOptions,
	wslPath: string,
	defaultDistro: string | null,
): string[] {
	const distro = options.distribution ?? defaultDistro;
	const args: string[] = [];
	if (distro) args.push("-d", distro);
	if (options.cwd) args.push("--cd", windowsToWslPath(options.cwd));
	args.push("--", ...commandTokens);
	return [wslPath, ...args];
}

/**
 * 构造 wslExec 的环境变量（含 WSLENV 传递）。
 *
 * WSLENV 格式：`NAME/u` 表示路径转换、`NAME` 表示原样传递。多个变量以 `:` 分隔。
 * 调用者传入的 env 变量会同时写入 wsl.exe 的环境，并追加到 WSLENV。
 *
 * @param env 用户传入的环境变量
 * @param baseEnv 继承的基础环境（通常是 process.env）
 */
export function buildWslEnv(
	env: Record<string, string> | undefined,
	baseEnv: Record<string, string>,
): Record<string, string> {
	const merged: Record<string, string> = { ...baseEnv };
	if (!env || Object.keys(env).length === 0) return merged;

	const existingWslenv = merged.WSLENV ? merged.WSLENV.split(":").filter(Boolean) : [];
	const additions: string[] = [];
	for (const name of Object.keys(env)) {
		merged[name] = env[name];
		// 值含盘符路径时按路径转换（`/u` 标记），否则原样传递。
		additions.push(/^[a-zA-Z]:[\\/]/.test(env[name]) ? `${name}/u` : name);
	}
	const wslenv = [...existingWslenv, ...additions].join(":");
	if (wslenv.length > 0) merged.WSLENV = wslenv;
	return merged;
}

/**
 * 在 WSL 内执行命令并捕获输出。
 *
 * 构造 `wsl.exe -d <distro> --cd <wslCwd> -- <command>`，env 通过 WSLENV 传递。
 * wsl.exe 不可用或调用失败时返回非零 exitCode 与空输出。
 */
export async function wslExec(command: string, options?: WslExecOptions): Promise<WslExecResult> {
	if (process.platform !== "win32") {
		return { stdout: "", stderr: "wslExec is only available on Windows", exitCode: 1 };
	}
	const wslPath = $which("wsl") ?? $which("wsl.exe");
	if (!wslPath) {
		return { stdout: "", stderr: "wsl.exe not found", exitCode: 1 };
	}

	const info = await detectWsl();
	const defaultDistro = info.available ? info.defaultDistribution : null;
	const commandTokens = command.split(/\s+/).filter(Boolean);
	if (commandTokens.length === 0) {
		return { stdout: "", stderr: "empty command", exitCode: 1 };
	}

	const args = buildWslExecArgs(commandTokens, options ?? {}, wslPath, defaultDistro);
	const env = buildWslEnv(options?.env, process.env as Record<string, string>);

	try {
		const proc = Bun.spawn({
			cmd: args,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { stdout: "", stderr: message, exitCode: 1 };
	}
}

/**
 * 在 WSL2 内启动 agent（inherit stdio，让用户直接交互）。
 *
 * 流程：
 * 1. 检测 WSL2 可用性
 * 2. 检测 WSL 内是否已安装 nexus（`wsl -- which nexus`）
 * 3. 未安装则打印安装指引
 * 4. 已安装则用 inherit stdio 启动 `wsl.exe -d <distro> --cd <wslPath> -- nexus <args>`
 */
export async function launchInWsl(options: {
	distribution?: string;
	/** 项目路径（Windows 路径，自动转换） */
	projectPath: string;
	/** 传给 nexus 的额外参数 */
	args?: string[];
}): Promise<void> {
	const info = await detectWsl();
	if (!info.available || !info.wslPath) {
		process.stderr.write("WSL2 is not available. Install WSL2 first: wsl --install\n");
		process.exitCode = 1;
		return;
	}

	const distro = options.distribution ?? info.defaultDistribution;
	if (!distro) {
		process.stderr.write("No WSL distribution found.\n");
		process.exitCode = 1;
		return;
	}

	// 检测 WSL 内是否已安装 nexus。
	const checkResult = await wslExec("which nexus", { distribution: distro });
	const installed = checkResult.exitCode === 0 && checkResult.stdout.trim().length > 0;
	if (!installed) {
		process.stdout.write(`${WSL_INSTALL_INSTRUCTIONS}\n`);
		process.exitCode = 1;
		return;
	}

	const nexusArgs = options.args ?? [];
	const argv = buildWslExecArgs(
		["nexus", ...nexusArgs],
		{ distribution: distro, cwd: options.projectPath },
		info.wslPath,
		distro,
	);

	// inherit stdio 让用户直接与 WSL 内的 agent 交互。
	const proc = Bun.spawn({
		cmd: argv,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.exitCode = exitCode;
}
