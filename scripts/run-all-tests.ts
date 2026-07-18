#!/usr/bin/env bun
/**
 * Nexus Agent — 一站式测试套件整合脚本（Task 9.2）。
 *
 * 按顺序运行：
 *   1. cargo test --workspace              （Rust 单测 + 集成测试）
 *   2. bun test                            （TS 单测，工作区+packages）
 *   3. PTY e2e 测试                        （如果 omp 已有 PTY 测试）
 *   4. gRPC 端到端测试                     （packages/nexus-grpc/test/e2e.test.ts）
 *   5. sandbox 安全测试                    （crates/nexus-sandbox/tests/sandbox_rejects_rm_rf.rs）
 *
 * 使用：
 *   bun scripts/run-all-tests.ts           # 全部运行
 *   bun scripts/run-all-tests.ts --skip-rust   # 跳过 Rust
 *   bun scripts/run-all-tests.ts --skip-ts     # 跳过 TS
 *   bun scripts/run-all-tests.ts --only grpc   # 仅跑 gRPC e2e
 *
 * 退出码：0 = 全部通过；非 0 = 任意一段失败。
 *
 * 设计原则：
 *   - 容错：每段失败会记录但不立即终止后续段落，便于一次性看到所有失败
 *   - 报告：末尾打印汇总表（哪段通过/失败）
 *   - 跨平台：Windows 上能跑（用 bun 内置 cross-spawn，bash 步骤自动跳过）
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

const repoRoot = join(dirname(import.meta.dir));
const args = process.argv.slice(2);

const skipRust = args.includes("--skip-rust");
const skipTs = args.includes("--skip-ts");
const onlyIdx = args.indexOf("--only");
const onlyTarget = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

interface Stage {
	id: string;
	label: string;
	command: string[];
	cwd: string;
	skipped: boolean;
	result?: { exitCode: number; stdout: string; stderr: string };
}

const stages: Stage[] = [
	{
		id: "rust",
		label: "Rust 单测 + 集成测试 (cargo test --workspace)",
		command: ["cargo", "test", "--workspace", "--no-fail-fast"],
		cwd: repoRoot,
		skipped: skipRust || (onlyTarget !== null && onlyTarget !== "rust"),
	},
	{
		id: "ts",
		label: "TS 单测 (bun run ci:test:ts)",
		command: ["bun", "run", "ci:test:ts"],
		cwd: repoRoot,
		skipped: skipTs || (onlyTarget !== null && onlyTarget !== "ts"),
	},
	{
		id: "pty",
		label: "PTY e2e (coding-agent runtime 测试)",
		// PTY e2e 走 coding-agent runtime bucket（继承 omp 已有测试）
		command: ["bun", "run", "ci:test:coding-agent:runtime"],
		cwd: repoRoot,
		skipped: onlyTarget !== null && onlyTarget !== "pty",
	},
	{
		id: "grpc",
		label: "gRPC 端到端测试 (packages/nexus-grpc/test/e2e.test.ts)",
		command: ["bun", "test", "test/e2e.test.ts"],
		cwd: join(repoRoot, "packages/nexus-grpc"),
		skipped: onlyTarget !== null && onlyTarget !== "grpc",
	},
	{
		id: "sandbox",
		label: "sandbox 安全测试 (rm -rf / 被拒)",
		// 仅在 Unix 上跑——Windows 上 sandbox 走 ISO FS 降级路径，
		// 该测试文件本身有 #![cfg(unix)] 守卫，会自动跳过。
		command: ["cargo", "test", "--package", "nexus-sandbox", "--test", "sandbox_rejects_rm_rf", "--", "--nocapture"],
		cwd: repoRoot,
		skipped: onlyTarget !== null && onlyTarget !== "sandbox",
	},
];

// 过滤掉不存在的目标（避免 --only grpc 但 e2e.test.ts 不存在时假死）
for (const stage of stages) {
	if (!stage.skipped) {
		// 检查关键文件存在性
		if (stage.id === "grpc") {
			const grpcTestPath = join(repoRoot, "packages/nexus-grpc/test/e2e.test.ts");
			if (!existsSync(grpcTestPath)) {
				stage.skipped = true;
				console.warn(`[nexus-test] 跳过 ${stage.id}：未找到 ${grpcTestPath}`);
			}
		}
		if (stage.id === "sandbox") {
			const sandboxTestPath = join(repoRoot, "crates/nexus-sandbox/tests/sandbox_rejects_rm_rf.rs");
			if (!existsSync(sandboxTestPath)) {
				stage.skipped = true;
				console.warn(`[nexus-test] 跳过 ${stage.id}：未找到 ${sandboxTestPath}`);
			}
		}
	}
}

console.log("\n=== Nexus Agent 全套测试 ===\n");
console.log(`阶段数：${stages.length}（其中 ${stages.filter((s) => s.skipped).length} 个跳过）\n`);

const failures: Stage[] = [];
let anyRan = false;

for (const stage of stages) {
	const header = `── ${stage.label} ──`;
	console.log(`\n${header}\n`);
	if (stage.skipped) {
		console.log("  [SKIP]\n");
		continue;
	}
	anyRan = true;
	const result = await $`${stage.command}`.cwd(stage.cwd).nothrow().quiet();
	stage.result = {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
	if (result.stdout.length > 0) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr.length > 0) {
		process.stderr.write(result.stderr);
	}
	if (result.exitCode === 0) {
		console.log("  [PASS]\n");
	} else {
		console.log(`  [FAIL] exit=${result.exitCode}\n`);
		failures.push(stage);
	}
}

// 汇总
console.log("\n=== 汇总 ===\n");
for (const stage of stages) {
	const status = stage.skipped ? "SKIP" : stage.result?.exitCode === 0 ? "PASS" : "FAIL";
	console.log(`  [${status}] ${stage.id.padEnd(8)} — ${stage.label}`);
}

if (!anyRan) {
	console.log("\n没有运行任何阶段（全部被跳过）\n");
}

if (failures.length > 0) {
	console.error(`\n失败 ${failures.length} 个阶段：${failures.map((f) => f.id).join(", ")}\n`);
	process.exit(1);
}

console.log("\n全部测试通过！\n");
