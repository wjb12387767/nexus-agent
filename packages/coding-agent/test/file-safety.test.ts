import { describe, expect, it, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildWriteDeniedPaths,
	buildWriteDeniedPrefixes,
	classifyWriteDenial,
	getReadBlockError,
	getWriteDeniedError,
	getWriteSafeRoots,
} from "../src/tools/file-safety";

const HOME = os.homedir();
const SEP = path.sep;

/** 拼接 home 下的相对路径片段，跨平台安全。 */
function underHome(...segments: string[]): string {
	return path.join(HOME, ...segments);
}

describe("file-safety: buildWriteDeniedPaths", () => {
	it("包含 SSH 密钥与配置文件", () => {
		const denied = buildWriteDeniedPaths(HOME);
		expect(denied.has(path.resolve(underHome(".ssh", "id_rsa")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".ssh", "id_ed25519")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".ssh", "authorized_keys")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".ssh", "config")))).toBe(true);
	});

	it("包含各类包管理器凭证文件", () => {
		const denied = buildWriteDeniedPaths(HOME);
		expect(denied.has(path.resolve(underHome(".netrc")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".pgpass")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".npmrc")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".pypirc")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".git-credentials")))).toBe(true);
		expect(denied.has(path.resolve(underHome(".env")))).toBe(true);
	});

	it("包含系统级敏感文件", () => {
		const denied = buildWriteDeniedPaths(HOME);
		// /etc/sudoers 等在 Windows 上 resolve 为 <drive>:\etc\sudoers，仍应存在
		expect(denied.has(path.resolve("/etc/sudoers"))).toBe(true);
		expect(denied.has(path.resolve("/etc/passwd"))).toBe(true);
		expect(denied.has(path.resolve("/etc/shadow"))).toBe(true);
	});
});

describe("file-safety: buildWriteDeniedPrefixes", () => {
	it("包含凭证目录前缀且以分隔符结尾", () => {
		const prefixes = buildWriteDeniedPrefixes(HOME);
		const sshPrefix = path.resolve(underHome(".ssh")) + SEP;
		expect(prefixes).toContain(sshPrefix);

		const awsPrefix = path.resolve(underHome(".aws")) + SEP;
		expect(prefixes).toContain(awsPrefix);

		const kubePrefix = path.resolve(underHome(".kube")) + SEP;
		expect(prefixes).toContain(kubePrefix);
	});

	it("包含 .config/gh 与 .config/gcloud 前缀", () => {
		const prefixes = buildWriteDeniedPrefixes(HOME);
		const ghPrefix = path.resolve(underHome(".config", "gh")) + SEP;
		const gcloudPrefix = path.resolve(underHome(".config", "gcloud")) + SEP;
		expect(prefixes).toContain(ghPrefix);
		expect(prefixes).toContain(gcloudPrefix);
	});
});

describe("file-safety: classifyWriteDenial", () => {
	it("凭证文件路径返回 'credential'", () => {
		expect(classifyWriteDenial(underHome(".ssh", "id_rsa"))).toBe("credential");
		expect(classifyWriteDenial(underHome(".ssh", "id_ed25519"))).toBe("credential");
		expect(classifyWriteDenial(underHome(".env"))).toBe("credential");
		expect(classifyWriteDenial(underHome(".netrc"))).toBe("credential");
	});

	it("/etc/sudoers 返回 'credential'", () => {
		expect(classifyWriteDenial("/etc/sudoers")).toBe("credential");
	});

	it("凭证目录前缀下的路径返回 'credential'", () => {
		// ~/.ssh/ 下任意文件都应被拒
		expect(classifyWriteDenial(underHome(".ssh", "some_random_key"))).toBe("credential");
		expect(classifyWriteDenial(underHome(".aws", "credentials"))).toBe("credential");
		expect(classifyWriteDenial(underHome(".kube", "config"))).toBe("credential");
	});

	it("普通项目路径返回 null（允许写入）", () => {
		expect(classifyWriteDenial(path.join(os.tmpdir(), "project", "src", "index.ts"))).toBeNull();
		expect(classifyWriteDenial(path.join(os.tmpdir(), "README.md"))).toBeNull();
	});

	it("扩展 ~ 前缀的凭证路径返回 'credential'", () => {
		expect(classifyWriteDenial("~/.ssh/id_rsa")).toBe("credential");
		expect(classifyWriteDenial("~/")).toBeNull();
	});

	it("自定义拒绝路径被纳入", () => {
		const custom = path.join(os.tmpdir(), "my-secret.txt");
		expect(classifyWriteDenial(custom)).toBeNull();
		expect(classifyWriteDenial(custom, [custom])).toBe("credential");
	});

	it("不误伤名称前缀相似但不在凭证目录下的路径", () => {
		// ~/.ssh-backup 不应被 ~/.ssh/ 前缀匹配
		expect(classifyWriteDenial(underHome(".ssh-backup", "key"))).toBeNull();
	});
});

describe("file-safety: getWriteDeniedError", () => {
	it("凭证路径返回含 'Defense-in-depth' 的错误消息", () => {
		const err = getWriteDeniedError(underHome(".ssh", "id_rsa"));
		expect(err).not.toBeNull();
		expect(err!).toContain("Write denied");
		expect(err!).toContain("Defense-in-depth");
		expect(err!).toContain(".ssh");
	});

	it("普通路径返回 null", () => {
		expect(getWriteDeniedError(path.join(os.tmpdir(), "normal.txt"))).toBeNull();
	});

	it("verb 参数影响消息前缀", () => {
		const err = getWriteDeniedError(underHome(".env"), "Edit");
		expect(err).not.toBeNull();
		expect(err!).toContain("Edit denied");
	});
});

describe("file-safety: getReadBlockError", () => {
	it(".env 文件读取被拒", () => {
		const err = getReadBlockError(path.join(os.tmpdir(), "project", ".env"));
		expect(err).not.toBeNull();
		expect(err!).toContain("secret-bearing environment file");
		expect(err!).toContain("Defense-in-depth");
	});

	it(".env.local / .env.production 文件读取被拒", () => {
		expect(getReadBlockError(path.join(os.tmpdir(), ".env.local"))).not.toBeNull();
		expect(getReadBlockError(path.join(os.tmpdir(), ".env.production"))).not.toBeNull();
		expect(getReadBlockError(path.join(os.tmpdir(), ".envrc"))).not.toBeNull();
	});

	it(".env.example 不被拒", () => {
		expect(getReadBlockError(path.join(os.tmpdir(), "project", ".env.example"))).toBeNull();
	});

	it("普通文件读取不被拒", () => {
		expect(getReadBlockError(path.join(os.tmpdir(), "README.md"))).toBeNull();
		expect(getReadBlockError(path.join(os.tmpdir(), "src", "index.ts"))).toBeNull();
	});

	it("blockEnvFiles=false 时 .env 文件读取不被拒", () => {
		expect(getReadBlockError(path.join(os.tmpdir(), ".env"), false)).toBeNull();
	});

	it("~ 前缀的 .env 路径被拒", () => {
		expect(getReadBlockError("~/.env")).not.toBeNull();
	});
});

describe("file-safety: NEXUS_WRITE_SAFE_ROOT", () => {
	const originalEnv = process.env.NEXUS_WRITE_SAFE_ROOT;

	afterEach(() => {
		// 恢复环境变量
		if (originalEnv === undefined) {
			delete process.env.NEXUS_WRITE_SAFE_ROOT;
		} else {
			process.env.NEXUS_WRITE_SAFE_ROOT = originalEnv;
		}
	});

	it("未设置时不启用 safe_root 限制", () => {
		delete process.env.NEXUS_WRITE_SAFE_ROOT;
		const roots = getWriteSafeRoots();
		expect(roots.size).toBe(0);
		// 普通路径允许
		expect(classifyWriteDenial(path.join(os.tmpdir(), "anywhere.txt"))).toBeNull();
	});

	it("设置后非 safe_root 路径返回 'safe_root'", () => {
		const safeDir = os.tmpdir();
		process.env.NEXUS_WRITE_SAFE_ROOT = safeDir;
		const roots = getWriteSafeRoots();
		expect(roots.size).toBe(1);

		// safe_root 内允许
		expect(classifyWriteDenial(path.join(safeDir, "project", "file.ts"))).toBeNull();
		// safe_root 外被拒
		const outside = path.join(SEP === "\\" ? "C:\\" : "/", "nonexistent-safe-root", "file.ts");
		const denial = classifyWriteDenial(outside);
		// 凭证路径仍优先返回 credential，非凭证的 outside 才返回 safe_root
		if (denial !== "credential") {
			expect(denial).toBe("safe_root");
		}
	});

	it("safe_root 限制不覆盖凭证路径拒绝", () => {
		const safeDir = os.tmpdir();
		process.env.NEXUS_WRITE_SAFE_ROOT = safeDir;
		// ~/.ssh/id_rsa 既是凭证路径又在 safe_root 外，应返回 credential（优先级更高）
		expect(classifyWriteDenial(underHome(".ssh", "id_rsa"))).toBe("credential");
	});

	it("safe_root 错误消息包含 NEXUS_WRITE_SAFE_ROOT 字样", () => {
		const safeDir = os.tmpdir();
		process.env.NEXUS_WRITE_SAFE_ROOT = safeDir;
		const outside = path.join(SEP === "\\" ? "C:\\" : "/", "nonexistent-safe-root-xyz", "file.ts");
		const err = getWriteDeniedError(outside);
		if (err !== null) {
			expect(err).toContain("NEXUS_WRITE_SAFE_ROOT");
			expect(err).toContain("Defense-in-depth");
		}
	});

	it("支持多个 safe_root（以 path.delimiter 分隔）", () => {
		const dir1 = path.join(os.tmpdir(), "safe1");
		const dir2 = path.join(os.tmpdir(), "safe2");
		process.env.NEXUS_WRITE_SAFE_ROOT = `${dir1}${path.delimiter}${dir2}`;
		const roots = getWriteSafeRoots();
		expect(roots.size).toBe(2);
	});
});

describe("file-safety: Windows 路径兼容", () => {
	it("buildWriteDeniedPaths 返回的路径使用当前平台分隔符", () => {
		const denied = buildWriteDeniedPaths(HOME);
		const idRsa = path.resolve(underHome(".ssh", "id_rsa"));
		expect(denied.has(idRsa)).toBe(true);
		// 路径不应包含混合分隔符
		if (SEP === "\\") {
			expect(idRsa.includes("/")).toBe(false);
		}
	});

	it("正斜杠输入路径在 Windows 上也能正确分类", () => {
		// 跳过非 Windows 平台
		if (SEP !== "\\") return;
		const forwardSlashPath = HOME.replace(/\\/g, "/") + "/.ssh/id_rsa";
		expect(classifyWriteDenial(forwardSlashPath)).toBe("credential");
	});

	it("classifyWriteDenial 永不抛异常（输入畸形路径）", () => {
		expect(() => classifyWriteDenial("")).not.toThrow();
		expect(() => classifyWriteDenial("\0\0\0")).not.toThrow();
		expect(() => classifyWriteDenial("con:nul:prn")).not.toThrow();
	});

	it("getReadBlockError 永不抛异常（输入畸形路径）", () => {
		expect(() => getReadBlockError("")).not.toThrow();
		expect(() => getReadBlockError("\0\0\0")).not.toThrow();
	});
});
