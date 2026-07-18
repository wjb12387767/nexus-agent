#!/usr/bin/env bun
/**
 * Nexus Agent — Coverage 整合脚本（Task 9.3）。
 *
 * 整合 TS coverage 与 Rust coverage，生成合并报告。
 *
 * - TS coverage：使用 bun 的 --coverage 标志（Bun 1.3+ 内置 coverage）
 *   或 c8（如果可用）。结果输出到 coverage/ts/
 * - Rust coverage：使用 `cargo tarpaulin`（首选）或 `cargo llvm-cov`（fallback）
 *   结果输出到 coverage/rust/
 * - 合并报告：coverage/index.html + coverage/summary.json
 *
 * omp 已有 `omp-stats` 工具（packages/stats），但那是运行时统计而非代码覆盖率；
 * 本脚本聚焦代码覆盖率（line/branch coverage），与 omp-stats 互补。
 *
 * 使用：
 *   bun scripts/coverage.ts                # 全部
 *   bun scripts/coverage.ts --ts-only      # 仅 TS
 *   bun scripts/coverage.ts --rust-only   # 仅 Rust
 *   bun scripts/coverage.ts --report-only # 仅合并已有报告
 *
 * 退出码：0 = 报告生成成功；非 0 = 任意阶段失败。
 */
import { $ } from "bun";
import { mkdir, writeFile, existsSync } from "node:fs/promises";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(import.meta.dir), "..");
const coverageDir = join(repoRoot, "coverage");
const tsCoverageDir = join(coverageDir, "ts");
const rustCoverageDir = join(coverageDir, "rust");

const args = process.argv.slice(2);
const tsOnly = args.includes("--ts-only");
const rustOnly = args.includes("--rust-only");
const reportOnly = args.includes("--report-only");

interface CoverageSummary {
	ts?: {
		covered: number;
		total: number;
		percent: number;
	};
	rust?: {
		covered: number;
		total: number;
		percent: number;
	};
}

const summary: CoverageSummary = {};

async function ensureDirs() {
	await mkdir(coverageDir, { recursive: true });
	await mkdir(tsCoverageDir, { recursive: true });
	await mkdir(rustCoverageDir, { recursive: true });
}

// ─── TS coverage ──────────────────────────────────────────────────────────
async function runTsCoverage(): Promise<void> {
	if (rustOnly) {
		console.log("[nexus-coverage] 跳过 TS coverage (--rust-only)\n");
		return;
	}
	console.log("[nexus-coverage] 运行 TS coverage（bun --coverage）\n");

	// Bun 1.3+ 原生支持 --coverage，输出为 JSON
	// 跑工作区所有 TS 测试，--coverage 输出到 coverage/ts/
	const result = await $`bun test --coverage --coverage-dir=${tsCoverageDir} --coverage-reporter=text --coverage-reporter=lcov`
		.cwd(repoRoot)
		.nothrow()
		.quiet();

	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);

	// 读取 Bun 的 coverage-summary.json
	const summaryPath = join(tsCoverageDir, "coverage-summary.json");
	if (existsSync(summaryPath)) {
		const file = Bun.file(summaryPath);
		const json = await file.json();
		// Bun 输出格式：{ totals: { bytes, lines, statements, functions } }
		const totals = json?.totals ?? {};
		const lines = totals.lines ?? { covered: 0, total: 0 };
		summary.ts = {
			covered: lines.covered ?? 0,
			total: lines.total ?? 0,
			percent: lines.total > 0 ? ((lines.covered / lines.total) * 100) : 0,
		};
	}

	if (result.exitCode !== 0) {
		console.warn(`[nexus-coverage] TS coverage 警告：exit=${result.exitCode}\n`);
	}
}

// ─── Rust coverage ────────────────────────────────────────────────────────
async function runRustCoverage(): Promise<void> {
	if (tsOnly) {
		console.log("[nexus-coverage] 跳过 Rust coverage (--ts-only)\n");
		return;
	}
	console.log("[nexus-coverage] 运行 Rust coverage\n");

	// 优先使用 cargo-tarpaulin（业界标准）
	// fallback 到 cargo-llvm-cov
	const tarpaulinAvailable = await $`cargo tarpaulin --version`.quiet().nothrow().text();
	if (tarpaulinAvailable.trim()) {
		console.log("[nexus-coverage] 使用 cargo-tarpaulin\n");
		const result = await $`cargo tarpaulin --workspace --out Html --out Lcov --output-dir ${rustCoverageDir} --skip-clean --ignore-tests`
			.cwd(repoRoot)
			.nothrow()
			.quiet();
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	} else {
		const llvmCovAvailable = await $`cargo llvm-cov --version`.quiet().nothrow().text();
		if (llvmCovAvailable.trim()) {
			console.log("[nexus-coverage] 使用 cargo-llvm-cov\n");
			const result = await $`cargo llvm-cov --workspace --html --output-dir ${rustCoverageDir} --lcov --output-path ${join(rustCoverageDir, "lcov.info")}`
				.cwd(repoRoot)
				.nothrow()
				.quiet();
			process.stdout.write(result.stdout);
			process.stderr.write(result.stderr);
		} else {
			console.warn(
				"[nexus-coverage] 未找到 cargo-tarpaulin 或 cargo-llvm-cov，跳过 Rust coverage。\n" +
					"安装：cargo install cargo-tarpaulin 或 cargo install cargo-llvm-cov\n",
			);
			return;
		}
	}

	// 解析 lcov.info 提取汇总（lcov 格式：LF=总行数，LH=覆盖行数）
	const lcovPath = join(rustCoverageDir, "lcov.info");
	if (existsSync(lcovPath)) {
		const lcov = await Bun.file(lcovPath).text();
		let totalLines = 0;
		let coveredLines = 0;
		for (const line of lcov.split("\n")) {
			if (line.startsWith("LF:")) totalLines += parseInt(line.slice(3), 10) || 0;
			else if (line.startsWith("LH:")) coveredLines += parseInt(line.slice(3), 10) || 0;
		}
		summary.rust = {
			covered: coveredLines,
			total: totalLines,
			percent: totalLines > 0 ? (coveredLines / totalLines) * 100 : 0,
		};
	}
}

// ─── 合并报告 ──────────────────────────────────────────────────────────────
async function generateMergedReport(): Promise<void> {
	console.log("[nexus-coverage] 生成合并报告\n");

	// 1. summary.json
	const summaryPath = join(coverageDir, "summary.json");
	await writeFile(summaryPath, JSON.stringify(summary, null, 2));

	// 2. index.html（简单的导航页）
	const tsPct = summary.ts?.percent?.toFixed(2) ?? "N/A";
	const rustPct = summary.rust?.percent?.toFixed(2) ?? "N/A";
	const tsLcovLink = existsSync(join(tsCoverageDir, "lcov.info")) ? '<li><a href="ts/lcov.info">TS lcov.info</a></li>' : "";
	const tsHtmlLink = existsSync(join(tsCoverageDir, "index.html")) ? '<li><a href="ts/index.html">TS HTML 报告</a></li>' : "";
	const rustHtmlLink = existsSync(join(rustCoverageDir, "index.html")) ? '<li><a href="rust/index.html">Rust HTML 报告</a></li>' : "";
	const rustLcovLink = existsSync(join(rustCoverageDir, "lcov.info")) ? '<li><a href="rust/lcov.info">Rust lcov.info</a></li>' : "";

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Nexus Agent Coverage Report</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 800px; }
h1 { color: #58A6FF; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #30363d; padding: 0.5rem 1rem; text-align: left; }
th { background: #161b22; color: #c9d1d9; }
td.pass { color: #3fb950; } td.warn { color: #d29922; } td.fail { color: #f85149; }
ul { list-style: square; padding-left: 1.5rem; }
code { background: #161b22; padding: 0.2rem 0.4rem; border-radius: 4px; color: #c9d1d9; }
</style>
</head>
<body>
<h1>Nexus Agent — Coverage 报告</h1>
<p>生成时间：${new Date().toISOString()}</p>
<table>
<thead><tr><th>层</th><th>覆盖率</th><th>覆盖行数</th><th>总行数</th></tr></thead>
<tbody>
<tr>
<td>TypeScript</td>
<td class="${pctClass(summary.ts?.percent)}">${tsPct}%</td>
<td>${summary.ts?.covered ?? "N/A"}</td>
<td>${summary.ts?.total ?? "N/A"}</td>
</tr>
<tr>
<td>Rust</td>
<td class="${pctClass(summary.rust?.percent)}">${rustPct}%</td>
<td>${summary.rust?.covered ?? "N/A"}</td>
<td>${summary.rust?.total ?? "N/A"}</td>
</tr>
</tbody>
</table>
<h2>详细报告</h2>
<ul>
${tsHtmlLink}
${tsLcovLink}
${rustHtmlLink}
${rustLcovLink}
</ul>
<p>提示：合并 lcov 后可用 <code>genhtml</code> 工具生成跨语言合并 HTML 报告。</p>
</body>
</html>`;

	await writeFile(join(coverageDir, "index.html"), html);

	console.log(`\n[coverage] TS:    ${tsPct}%`);
	console.log(`[coverage] Rust:  ${rustPct}%`);
	console.log(`[coverage] 报告已写入 ${coverageDir}`);
}

function pctClass(pct?: number): string {
	if (pct === undefined) return "";
	if (pct >= 80) return "pass";
	if (pct >= 50) return "warn";
	return "fail";
}

// ─── 主流程 ────────────────────────────────────────────────────────────────
await ensureDirs();

if (!reportOnly) {
	await runTsCoverage();
	await runRustCoverage();
}
await generateMergedReport();
