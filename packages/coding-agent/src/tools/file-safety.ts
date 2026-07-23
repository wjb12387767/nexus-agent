/**
 * 文件安全护栏（参考 hermes 的 file_safety 能力）。
 *
 * 提供凭证路径保护与 .env 文件读取拦截，通过 beforeToolCall hook 注入。
 *
 * 重要：这是 defense-in-depth（纵深防御），不是安全边界。
 * bash 工具以同一 OS 用户身份运行，仍可通过 shell 绕过这些检查。
 * 护栏的价值在于：对遵守工具拒绝语义的模型返回清晰错误，促使其停止；
 * 并在日志中留下可见审计痕迹。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 防御纵深提示语，所有错误消息都包含此字样。 */
const DEFENSE_IN_DEPTH_SUFFIX =
	"Defense-in-depth — not a security boundary; the terminal tool can still bypass.";

/**
 * 安全解析路径为绝对路径，解析符号链接。
 * 路径不存在时回退到 path.resolve（词法归一化），永不抛异常。
 */
function resolveSafe(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		// 路径不存在（常见于即将创建的写入目标）或无权限：回退到词法归一化
		return path.resolve(p);
	}
}

/**
 * 构建 home 目录下的敏感路径并展开 `~`。
 * 输入以 `~` 开头时替换为 home，否则原样返回。
 */
function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(home, p.slice(2));
	}
	return p;
}

/**
 * 构建禁止写入的凭证文件绝对路径集合。
 *
 * 涵盖 SSH 密钥/配置、各类包管理器凭证、netrc/pgpass/git-credentials，
 * 以及系统级敏感文件（/etc/sudoers、/etc/passwd、/etc/shadow）。
 *
 * @param home 用户主目录绝对路径
 * @returns 凭证文件绝对路径集合（已 resolve + realpath）
 */
export function buildWriteDeniedPaths(home: string): Set<string> {
	const h = resolveSafe(home);
	const paths: string[] = [
		path.join(h, ".ssh", "authorized_keys"),
		path.join(h, ".ssh", "id_rsa"),
		path.join(h, ".ssh", "id_ed25519"),
		path.join(h, ".ssh", "config"),
		path.join(h, ".env"),
		path.join(h, ".netrc"),
		path.join(h, ".pgpass"),
		path.join(h, ".npmrc"),
		path.join(h, ".pypirc"),
		path.join(h, ".git-credentials"),
		// 系统级敏感文件（Unix；Windows 上 resolve 为 <drive>:\etc\... 不会误伤）
		"/etc/sudoers",
		"/etc/passwd",
		"/etc/shadow",
	];
	const result = new Set<string>();
	for (const p of paths) {
		try {
			result.add(resolveSafe(p));
		} catch {
			// 永不抛异常：resolveSafe 内部已兜底，此处仅作双保险
		}
	}
	return result;
}

/**
 * 构建禁止写入的凭证目录前缀集合。
 *
 * 涵盖 .ssh/、.aws/、.gnupg/、.kube/、.docker/、.azure/、
 * .config/gh/、.config/gcloud/，以及系统级 /etc/sudoers.d/、/etc/systemd/。
 * 任何落入这些目录前缀下的路径都被视为凭证路径而拒绝写入。
 *
 * @param home 用户主目录绝对路径
 * @returns 目录前缀字符串数组（每项以 path.sep 结尾，便于 startsWith 匹配）
 */
export function buildWriteDeniedPrefixes(home: string): string[] {
	const h = resolveSafe(home);
	const dirs: string[] = [
		path.join(h, ".ssh"),
		path.join(h, ".aws"),
		path.join(h, ".gnupg"),
		path.join(h, ".kube"),
		path.join(h, ".docker"),
		path.join(h, ".azure"),
		path.join(h, ".config", "gh"),
		path.join(h, ".config", "gcloud"),
		"/etc/sudoers.d",
		"/etc/systemd",
	];
	const result: string[] = [];
	for (const d of dirs) {
		try {
			const resolved = resolveSafe(d);
			// 确保前缀以分隔符结尾，避免 ~/.ssh 匹配 ~/.ssh-backup
			result.push(resolved.endsWith(path.sep) ? resolved : resolved + path.sep);
		} catch {
			// 永不抛异常
		}
	}
	return result;
}

/**
 * 从 NEXUS_WRITE_SAFE_ROOT 环境变量解析安全写入根目录集合。
 *
 * 支持以 path.delimiter 分隔的多个目录（Unix 为 `:`，Windows 为 `;`）。
 * 未设置时返回空集合（表示不启用 safe_root 限制）。
 *
 * @returns 解析后的安全根目录绝对路径集合
 */
export function getWriteSafeRoots(): Set<string> {
	const env = process.env.NEXUS_WRITE_SAFE_ROOT ?? "";
	if (env.length === 0) return new Set<string>();
	const home = os.homedir();
	const roots = new Set<string>();
	for (const raw of env.split(path.delimiter)) {
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		try {
			roots.add(resolveSafe(expandHome(trimmed, home)));
		} catch {
			// 跳过无法解析的条目
		}
	}
	return roots;
}

/**
 * 分类写入拒绝原因。
 *
 * @param filePath 待写入路径（相对或绝对）
 * @param extraDeniedPaths 额外自定义拒绝路径（来自 fileSafety.customDeniedPaths 配置）
 * @returns "credential"（命中凭证路径/前缀）| "safe_root"（在 NEXUS_WRITE_SAFE_ROOT 限制外）| null（允许写入）
 */
export function classifyWriteDenial(
	filePath: string,
	extraDeniedPaths: readonly string[] = [],
): "credential" | "safe_root" | null {
	try {
		const home = resolveSafe(os.homedir());
		const resolved = resolveSafe(expandHome(filePath, home));

		// 凭证文件精确匹配
		const deniedPaths = buildWriteDeniedPaths(home);
		for (const extra of extraDeniedPaths) {
			try {
				deniedPaths.add(resolveSafe(expandHome(extra, home)));
			} catch {
				// 跳过无法解析的自定义路径
			}
		}
		if (deniedPaths.has(resolved)) return "credential";

		// 凭证目录前缀匹配
		const prefixes = buildWriteDeniedPrefixes(home);
		for (const prefix of prefixes) {
			if (resolved.startsWith(prefix)) return "credential";
		}

		// safe_root 限制：设置 NEXUS_WRITE_SAFE_ROOT 后，仅允许写入这些根目录下
		const safeRoots = getWriteSafeRoots();
		if (safeRoots.size > 0) {
			let allowed = false;
			for (const root of safeRoots) {
				if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
					allowed = true;
					break;
				}
			}
			if (!allowed) return "safe_root";
		}

		return null;
	} catch {
		// 防御性兜底：guard 永不抛异常，异常时放行（不阻断正常工作流）
		return null;
	}
}

/**
 * 返回写入被拒绝时的错误消息。
 *
 * @param filePath 待写入路径
 * @param verb 动词（默认 "Write"），用于消息前缀
 * @param extraDeniedPaths 额外自定义拒绝路径
 * @returns 错误消息字符串，允许写入时返回 null
 */
export function getWriteDeniedError(
	filePath: string,
	verb = "Write",
	extraDeniedPaths: readonly string[] = [],
): string | null {
	try {
		const denial = classifyWriteDenial(filePath, extraDeniedPaths);
		if (denial === null) return null;
		if (denial === "safe_root") {
			const roots = getWriteSafeRoots();
			const rootsDisplay = Array.from(roots).sort().join(path.delimiter);
			return (
				`${verb} denied: '${filePath}' is outside NEXUS_WRITE_SAFE_ROOT ` +
				`(${rootsDisplay}). Unset the variable or add this path's directory prefix. ` +
				DEFENSE_IN_DEPTH_SUFFIX
			);
		}
		return `${verb} denied: '${filePath}' is a protected system/credential file. ${DEFENSE_IN_DEPTH_SUFFIX}`;
	} catch {
		return null;
	}
}

/** 禁止读取的 secret-bearing 环境文件 basename 集合。 */
const BLOCKED_ENV_BASENAMES: ReadonlySet<string> = new Set([
	".env",
	".env.local",
	".env.development",
	".env.production",
	".env.test",
	".env.staging",
	".envrc",
]);

/**
 * 返回读取被拒绝时的错误消息。
 *
 * 拦截 common secret-bearing 环境文件（.env / .env.local / .env.production 等），
 * 防止凭证泄露。建议模型改读 .env.example 了解文件结构。
 *
 * @param filePath 待读取路径
 * @param blockEnvFiles 是否启用 .env 文件拦截（默认 true）
 * @returns 错误消息字符串，允许读取时返回 null
 */
export function getReadBlockError(filePath: string, blockEnvFiles = true): string | null {
	try {
		const home = resolveSafe(os.homedir());
		const resolved = resolveSafe(expandHome(filePath, home));
		const base = path.basename(resolved).toLowerCase();

		if (blockEnvFiles && BLOCKED_ENV_BASENAMES.has(base)) {
			return (
				`Access denied: '${filePath}' is a secret-bearing environment file ` +
				`and cannot be read to prevent credential leakage. ` +
				`If you need to check the file structure, read .env.example instead. ` +
				DEFENSE_IN_DEPTH_SUFFIX
			);
		}
		return null;
	} catch {
		return null;
	}
}
