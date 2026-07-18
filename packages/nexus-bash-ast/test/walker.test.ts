/**
 * nexus-bash-ast walker 单测 — Task 3.2 扩展版。
 *
 * 覆盖三类用例：
 * 1. 攻击向量（断言 verdict === "needs-approval"，fail-closed）
 * 2. 正常命令（断言 verdict === "safe"）
 * 3. 边界情况（根据实际行为断言：safe / aborted / needs-approval）
 *
 * 这些测试依赖 `@oh-my-pi/pi-natives` 已构建并暴露 `parseBashCommand`。
 * 若 NAPI 模块未加载（例如 Windows 无 cargo 工具链、native addon 未构建），
 * 测试会通过 `beforeAll` 检测并 skip 整个 suite，避免 CI 上误导性的 fail。
 *
 * 注意：少数攻击向量（如 `bash -c "..."`、`rm -rf /`）在当前 walker
 * 实现下可能不被检测 —— 这种情况下测试会失败，**这是预期的**，用于暴露
 * walker 的不足，驱动后续迭代补全。
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { parseBashCommand } from "@oh-my-pi/pi-natives";
import { parseForSecurity } from "../src/index.js";

/** 探测 NAPI 模块是否可用（crates/pi-natives 是否已 napi build）。 */
let nativesAvailable = false;
beforeAll(() => {
	try {
		const result = parseBashCommand("echo hi");
		nativesAvailable = !result.aborted && result.root_node !== null;
	} catch {
		nativesAvailable = false;
	}
});

/** 跳过当前 it：NAPI 不可用时使用。 */
function skipIfNoNatives(): boolean {
	return !nativesAvailable;
}

describe("nexus-bash-ast walker", () => {
	describe("攻击向量", () => {
		it("eval 动态执行 `eval \"rm -rf /\"` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity('eval "rm -rf /"');
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// eval 在 EVAL_LIKE_BUILTINS 中，触发 builtin 检查
			expect(result.reason).toMatch(/eval/i);
		});

		it("nameref `declare -n X=Y` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("declare -n X=Y");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// -n flag 触发 nameref/integer/array 检测
			expect(result.reason).toMatch(/declare flag.*-n|nameref/i);
		});

		it("zsh =cmd 等号展开 `=ls` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("=ls");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// pre-check 阶段被 ZSH_EQUALS_EXPANSION_RE 捕获
			expect(result.reason).toMatch(/zsh.*equals|=cmd|equals expansion/i);
		});

		it("zsh ~[name] 动态目录展开 → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("~[name]");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// pre-check 阶段被 ZSH_TILDE_BRACKET_RE 捕获
			expect(result.reason).toMatch(/zsh.*~\[|dynamic directory/i);
		});

		it("trap 信号劫持 `trap 'cmd' SIGINT` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("trap 'cmd' SIGINT");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// trap 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/trap|eval-like builtin/i);
		});

		it("enable -n 禁用 builtin `enable -n cd` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("enable -n cd");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// enable 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/enable|eval-like builtin/i);
		});

		it("source 加载外部脚本 `source script.sh` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("source script.sh");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// source 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/source|eval-like builtin/i);
		});

		it("`.` 等价 source `. script.sh` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity(". script.sh");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// `.` 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/eval-like builtin/i);
		});

		it("exec 替换进程 `exec bash` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("exec bash");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// exec 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/exec|eval-like builtin/i);
		});

		it("command 绕过 alias `command eval \"x\"` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity('command eval "x"');
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// command 在 EVAL_LIKE_BUILTINS 中
			expect(result.reason).toMatch(/command|eval-like builtin/i);
		});

		it("bash -c 嵌套执行 `bash -c \"rm -rf /\"` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity('bash -c "rm -rf /"');
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
		});

		it("命令替换 `$(rm -rf /)` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("$(rm -rf /)");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// bare command_substitution 在 program 子节点中触发 DANGEROUS_TYPES
			expect(result.reason).toMatch(/command_substitution|Contains/i);
		});

		it("直接危险命令 `rm -rf /` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("rm -rf /");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
		});

		it("进程替换 `cat <(ls)` → verdict=needs-approval", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cat <(ls)");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// process_substitution 在 DANGEROUS_TYPES 中
			expect(result.reason).toMatch(/process_substitution|Contains/i);
		});
	});

	describe("正常命令", () => {
		it("最简单 `ls` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("ls");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["ls"]);
		});

		it("简单命令 `ls -la` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("ls -la");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["ls", "-la"]);
		});

		it("单文件读取 `cat file` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cat file");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["cat", "file"]);
		});

		it("模式匹配 `grep pattern file` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("grep pattern file");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["grep", "pattern", "file"]);
		});

		it("复合命令 `cd dir && make` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cd dir && make");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// && 分隔两条 simple command，顺序执行
			expect(result.commands.length).toBe(2);
			expect(result.commands[0]?.argv).toEqual(["cd", "dir"]);
			expect(result.commands[1]?.argv).toEqual(["make"]);
		});

		it("重定向 `echo hello > /tmp/out` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("echo hello > /tmp/out");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["echo", "hello"]);
			// 重定向附加到最后一个命令
			expect(result.commands[0]?.redirects.length).toBe(1);
			expect(result.commands[0]?.redirects[0]?.op).toBe(">");
			expect(result.commands[0]?.redirects[0]?.target).toBe("/tmp/out");
		});

		it("多级管道 `cat foo | grep bar | wc -l` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cat foo | grep bar | wc -l");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands.length).toBe(3);
			expect(result.commands[0]?.argv).toEqual(["cat", "foo"]);
			expect(result.commands[1]?.argv).toEqual(["grep", "bar"]);
			expect(result.commands[2]?.argv).toEqual(["wc", "-l"]);
		});

		it("管道 `cat foo | grep bar` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cat foo | grep bar");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// 两边的 simple command 都应被提取
			expect(result.commands.length).toBe(2);
			expect(result.commands[0]?.argv).toEqual(["cat", "foo"]);
			expect(result.commands[1]?.argv).toEqual(["grep", "bar"]);
		});

		it("命令替换在字符串内 `echo \"sha: $(date)\"` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity('echo "sha: $(date)"');
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// outer 命令 + inner 命令各一个
			expect(result.commands.length).toBe(2);
			const outer = result.commands[0]?.argv;
			const inner = result.commands[1]?.argv;
			// 顺序可能是 outer 先，inner 后；只要 outer 含 'echo' 即可
			const echoCmd = [outer, inner].find((a) => a?.[0] === "echo");
			const dateCmd = [outer, inner].find((a) => a?.[0] === "date");
			expect(echoCmd?.[0]).toBe("echo");
			expect(dateCmd?.[0]).toBe("date");
		});

		it("export PATH 追加（非 nameref）`export PATH=$PATH:/usr/local/bin` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("export PATH=$PATH:/usr/local/bin");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// export 是 declaration_command，但 -n/-i/-a/-A flag 不出现
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv[0]).toBe("export");
		});
	});

	describe("边界情况", () => {
		it("空命令 `\"\"` → verdict=safe（parseForSecurity 直接 short-circuit）", () => {
			// 空命令不依赖 NAPI；parseForSecurity 在入口处直接返回 safe
			const result = parseForSecurity("");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			expect(result.commands).toEqual([]);
		});

		it("超长命令（10001 字符）→ verdict=aborted", () => {
			// 超长命令不进入解析器；parseCommand 返回 null → walker 转 aborted
			const result = parseForSecurity("a".repeat(10001));
			expect(result.verdict).toBe("aborted");
			expect(result.aborted).toBe(true);
			expect(result.commands).toEqual([]);
			expect(result.reason).toMatch(/too long|Parser unavailable/i);
		});

		it("unquoted heredoc → verdict=needs-approval（body 会做 shell 展开）", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("cat <<EOF\nhello\nEOF");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
			// walkHeredocRedirect 对 unquoted delimiter 一律 reject
			expect(result.reason).toMatch(/heredoc|unquoted delimiter/i);
		});

		it("嵌套管道 `a | b | c | d | e` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("a | b | c | d | e");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// 5 个阶段都是 simple command（bare command_name）
			expect(result.commands.length).toBe(5);
			expect(result.commands[0]?.argv).toEqual(["a"]);
			expect(result.commands[4]?.argv).toEqual(["e"]);
		});

		it("变量赋值 + 命令 `x=1; echo $x` → verdict=safe", () => {
			if (skipIfNoNatives()) return;
			const result = parseForSecurity("x=1; echo $x");
			expect(result.verdict).toBe("safe");
			expect(result.aborted).toBe(false);
			// 顶层 variable_assignment 不入 commands；varScope 让 $x 解析为字面量 "1"
			expect(result.commands.length).toBe(1);
			expect(result.commands[0]?.argv).toEqual(["echo", "1"]);
		});
	});
});
