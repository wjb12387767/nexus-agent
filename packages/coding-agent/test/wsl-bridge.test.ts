import { describe, expect, it } from "bun:test";
import {
	buildWslEnv,
	buildWslExecArgs,
	parseWslListOutput,
	wslToWindowsPath,
	windowsToWslPath,
} from "@oh-my-pi/pi-coding-agent/wsl-bridge";

/** 将文本编码为 UTF-16LE Buffer（可选带 BOM），模拟 wsl.exe 的 stdout。 */
function utf16le(text: string, withBom = false): Buffer {
	const body = Buffer.from(text, "utf16le");
	return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

// ═══════════════════════════════════════════════════════════════════════════
// windowsToWslPath
// ═══════════════════════════════════════════════════════════════════════════

describe("windowsToWslPath", () => {
	it("converts a drive-letter path to /mnt/<drive>/...", () => {
		expect(windowsToWslPath("C:\\Users\\foo\\project")).toBe("/mnt/c/Users/foo/project");
	});

	it("lowercases the drive letter", () => {
		expect(windowsToWslPath("D:\\dir")).toBe("/mnt/d/dir");
	});

	it("converts a bare drive root", () => {
		expect(windowsToWslPath("C:\\")).toBe("/mnt/c");
	});

	it("handles paths with spaces", () => {
		expect(windowsToWslPath("C:\\Program Files\\foo bar")).toBe("/mnt/c/Program Files/foo bar");
	});

	it("converts forward-slash drive paths", () => {
		expect(windowsToWslPath("C:/Users/foo")).toBe("/mnt/c/Users/foo");
	});

	it("converts UNC paths to /mnt/<server>/<share>/...", () => {
		expect(windowsToWslPath("\\\\server\\share\\path")).toBe("/mnt/server/share/path");
	});

	it("converts forward-slash UNC paths", () => {
		expect(windowsToWslPath("//server/share/path")).toBe("/mnt/server/share/path");
	});

	it("passes through already-WSL-style paths unchanged", () => {
		expect(windowsToWslPath("/home/user/project")).toBe("/home/user/project");
	});

	it("returns empty string unchanged", () => {
		expect(windowsToWslPath("")).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// wslToWindowsPath
// ═══════════════════════════════════════════════════════════════════════════

describe("wslToWindowsPath", () => {
	it("converts /mnt/<drive>/... to <DRIVE>:\\...", () => {
		expect(wslToWindowsPath("/mnt/c/Users/foo")).toBe("C:\\Users\\foo");
	});

	it("uppercases the drive letter", () => {
		expect(wslToWindowsPath("/mnt/d/dir")).toBe("D:\\dir");
	});

	it("converts a bare /mnt/<drive> root", () => {
		expect(wslToWindowsPath("/mnt/c/")).toBe("C:\\");
	});

	it("does not convert WSL-native paths (/home, /usr, etc.)", () => {
		expect(wslToWindowsPath("/home/user")).toBe("/home/user");
		expect(wslToWindowsPath("/usr/local/bin")).toBe("/usr/local/bin");
	});

	it("does not convert /mnt without a drive letter", () => {
		expect(wslToWindowsPath("/mnt")).toBe("/mnt");
	});

	it("returns empty string unchanged", () => {
		expect(wslToWindowsPath("")).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseWslListOutput (detectWsl 的纯解析层)
// ═══════════════════════════════════════════════════════════════════════════

describe("parseWslListOutput", () => {
	it("parses a single Running WSL2 distribution with default marker", () => {
		const output = utf16le("  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n");
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.distributions).toEqual(["Ubuntu"]);
		expect(info.defaultDistribution).toBe("Ubuntu");
		expect(info.version).toBe(2);
	});

	it("parses multiple distributions and respects the default marker", () => {
		const output = utf16le(
			"  NAME            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n  Debian          Stopped         2\r\n  kali-linux      Running         1\r\n",
		);
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.distributions).toEqual(["Ubuntu-22.04", "Debian", "kali-linux"]);
		expect(info.defaultDistribution).toBe("Ubuntu-22.04");
		// version 取默认发行版的版本号
		expect(info.version).toBe(2);
	});

	it("reports version 1 when the default distribution is WSL1", () => {
		const output = utf16le(
			"  NAME            STATE           VERSION\r\n* legacy          Running         1\r\n  Ubuntu          Running         2\r\n",
		);
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.version).toBe(1);
		expect(info.defaultDistribution).toBe("legacy");
	});

	it("distinguishes Running vs Stopped distributions (both are listed)", () => {
		const output = utf16le(
			"  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n  docker-desktop  Stopped         2\r\n",
		);
		const info = parseWslListOutput(output);
		expect(info.distributions).toEqual(["Ubuntu", "docker-desktop"]);
	});

	it("strips a UTF-16LE BOM if present", () => {
		const output = utf16le(
			"\uFEFF  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n",
			false,
		);
		// 文本内嵌 BOM（\uFEFF）+ 外层 BOM 都应被正确处理
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.distributions).toEqual(["Ubuntu"]);
	});

	it("handles a real BOM-prefixed buffer", () => {
		const output = utf16le("* Ubuntu          Running         2\r\n", true);
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.distributions).toEqual(["Ubuntu"]);
		expect(info.defaultDistribution).toBe("Ubuntu");
		expect(info.version).toBe(2);
	});

	it("falls back to the first distribution when no default marker is present", () => {
		const output = utf16le(
			"  NAME            STATE           VERSION\r\n  Ubuntu          Running         2\r\n  Debian          Stopped         1\r\n",
		);
		const info = parseWslListOutput(output);
		expect(info.available).toBe(true);
		expect(info.defaultDistribution).toBe("Ubuntu");
		expect(info.version).toBe(2);
	});

	it("returns unavailable for an empty buffer", () => {
		const info = parseWslListOutput(Buffer.alloc(0));
		expect(info.available).toBe(false);
		expect(info.distributions).toEqual([]);
		expect(info.defaultDistribution).toBeNull();
		expect(info.version).toBeNull();
	});

	it("returns unavailable for a header-only buffer with no distributions", () => {
		const output = utf16le("  NAME            STATE           VERSION\r\n");
		const info = parseWslListOutput(output);
		expect(info.available).toBe(false);
	});

	it("handles distribution names with dots and hyphens", () => {
		const output = utf16le(
			"  NAME            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n  my-distro.1     Stopped         2\r\n",
		);
		const info = parseWslListOutput(output);
		expect(info.distributions).toEqual(["Ubuntu-22.04", "my-distro.1"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// buildWslExecArgs (wslExec 的纯构造层)
// ═══════════════════════════════════════════════════════════════════════════

describe("buildWslExecArgs", () => {
	it("constructs argv with distro, converted cwd, and command tokens", () => {
		const args = buildWslExecArgs(["ls", "-la"], { distribution: "Ubuntu", cwd: "C:\\foo" }, "wsl.exe", null);
		expect(args).toEqual(["wsl.exe", "-d", "Ubuntu", "--cd", "/mnt/c/foo", "--", "ls", "-la"]);
	});

	it("falls back to the default distribution when distribution is omitted", () => {
		const args = buildWslExecArgs(["echo", "hi"], {}, "wsl.exe", "Debian");
		expect(args).toEqual(["wsl.exe", "-d", "Debian", "--", "echo", "hi"]);
	});

	it("omits -d when neither distribution nor defaultDistro is given", () => {
		const args = buildWslExecArgs(["pwd"], {}, "wsl.exe", null);
		expect(args).toEqual(["wsl.exe", "--", "pwd"]);
	});

	it("omits --cd when cwd is not provided", () => {
		const args = buildWslExecArgs(["pwd"], { distribution: "Ubuntu" }, "wsl.exe", null);
		expect(args).toEqual(["wsl.exe", "-d", "Ubuntu", "--", "pwd"]);
	});

	it("converts a complex Windows cwd to a WSL path", () => {
		const args = buildWslExecArgs(
			["nexus"],
			{ distribution: "Ubuntu", cwd: "D:\\Projects\\my app" },
			"wsl.exe",
			null,
		);
		expect(args).toEqual(["wsl.exe", "-d", "Ubuntu", "--cd", "/mnt/d/Projects/my app", "--", "nexus"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// buildWslEnv (wslExec 的 env/WSLENV 传递层)
// ═══════════════════════════════════════════════════════════════════════════

describe("buildWslEnv", () => {
	it("passes through env vars and appends them to WSLENV without path conversion", () => {
		const env = buildWslEnv({ FOO: "bar", BAZ: "qux" }, { PATH: "/usr/bin" });
		expect(env.FOO).toBe("bar");
		expect(env.BAZ).toBe("qux");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.WSLENV).toBe("FOO:BAZ");
	});

	it("marks path-valued env vars with /u for Windows→WSL path conversion", () => {
		const env = buildWslEnv({ PROJECT: "C:\\code" }, {});
		expect(env.PROJECT).toBe("C:\\code");
		expect(env.WSLENV).toBe("PROJECT/u");
	});

	it("preserves an existing WSLENV and appends new entries", () => {
		const env = buildWslEnv({ NEW_VAR: "value" }, { WSLENV: "EXISTING/u" });
		expect(env.WSLENV).toBe("EXISTING/u:NEW_VAR");
	});

	it("returns the base env unchanged when no env vars are provided", () => {
		const env = buildWslEnv(undefined, { PATH: "/usr/bin", HOME: "/home/user" });
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
		expect(env.WSLENV).toBeUndefined();
	});

	it("mixes path and non-path vars in WSLENV", () => {
		const env = buildWslEnv({ API_KEY: "secret", WORKSPACE: "C:\\ws" }, {});
		expect(env.WSLENV).toBe("API_KEY:WORKSPACE/u");
	});
});
