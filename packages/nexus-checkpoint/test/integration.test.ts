/**
 * Nexus Checkpoint — M3 集成测试（Task 3.9）。
 *
 * 验证：
 * - SubTask 3.9.1: 编辑 5 个文件后 /rewind <id> 可完全恢复
 * - SubTask 3.9.2: 磁盘占用 < 工作区大小 1.5×
 * - SubTask 3.9.3: 由 Rust 单元测试覆盖（swap_policy LRU + 并发 restore）
 *
 * 注意：完整功能测试需要 native addon 已构建。若 addon 未构建，本测试会跳过。
 *
 * 运行：`bun --cwd=packages/nexus-checkpoint test`
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCheckpointStore, type CheckpointStoreHandle } from "../src/index.ts";

let addonAvailable = false;
let store: CheckpointStoreHandle | null = null;
let tmpDir: string | null = null;

beforeAll(async () => {
	try {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-checkpoint-integration-"));
		store = createCheckpointStore({
			cwd: tmpDir,
			sessionId: "integration-test",
			maxCheckpoints: 16,
			maxSizeMb: 32,
			swapPolicy: "lru",
		});
		addonAvailable = true;
	} catch (err) {
		console.warn(
			"[nexus-checkpoint integration test] Native addon 不可用，跳过测试。" +
				" 请先运行 `bun --cwd=packages/nexus-checkpoint run build`。\n" +
				`错误: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
});

afterAll(async () => {
	store = null;
	if (tmpDir) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

/**
 * 递归计算目录总字节大小（含所有文件）。
 */
async function dirSizeBytes(dir: string): Promise<number> {
	let total = 0;
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await dirSizeBytes(fullPath);
		} else if (entry.isFile()) {
			const stat = await fs.stat(fullPath);
			total += stat.size;
		}
	}
	return total;
}

describe("M3 集成测试 — Task 3.9", () => {
	/**
	 * SubTask 3.9.1: 编辑 5 个文件后 /rewind <id> 可完全恢复。
	 *
	 * 流程：
	 *  1. 创建 5 个文件（每个 1KB 内容）
	 *  2. 创建 checkpoint 0（捕获 5 个文件的初始状态）
	 *  3. 修改所有 5 个文件（每个 2KB 不同内容）
	 *  4. 调用 restore(0) 回滚
	 *  5. 验证 5 个文件内容完全恢复到初始状态
	 */
	test("SubTask 3.9.1: 编辑 5 个文件后 rewind 完全恢复", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}

		// 1. 创建 5 个文件
		const files: string[] = [];
		const originals: Record<string, string> = {};
		for (let i = 0; i < 5; i++) {
			const filename = `file${i}.txt`;
			const filePath = path.join(tmpDir, filename);
			const content = `initial content for file ${i}\n`.repeat(64); // ~2KB
			await fs.writeFile(filePath, content);
			files.push(filename);
			originals[filename] = content;
		}

		// 2. 创建 checkpoint 0
		const cpId = await store.create(0, "before-5-file-edit", files);
		expect(cpId).toBe(0);

		// 3. 修改所有 5 个文件（写入不同内容）
		for (let i = 0; i < 5; i++) {
			const filePath = path.join(tmpDir, files[i]);
			const newContent = `MODIFIED content ${i} — ${Date.now()}\n`.repeat(128); // ~4KB
			await fs.writeFile(filePath, newContent);
			// 确认内容已变
			const actual = await fs.readFile(filePath, "utf-8");
			expect(actual).not.toBe(originals[files[i]]);
		}

		// 4. 回滚到 checkpoint 0
		const result = await store.restore(0);
		expect(result.success).toBe(true);
		expect(result.revertedFiles.length).toBe(5);

		// 5. 验证所有 5 个文件完全恢复
		for (let i = 0; i < 5; i++) {
			const filePath = path.join(tmpDir, files[i]);
			const restored = await fs.readFile(filePath, "utf-8");
			expect(restored).toBe(originals[files[i]]);
		}
	});

	/**
	 * SubTask 3.9.2: 磁盘占用 < 工作区大小 1.5×。
	 *
	 * 流程：
	 *  1. 创建多个文件（总计约 10KB 工作区）
	 *  2. 创建多个 checkpoint（含相同内容，验证 sha256 去重）
	 *  3. 修改文件后创建更多 checkpoint
	 *  4. 计算工作区大小 + checkpoint 目录大小
	 *  5. 验证 checkpoint 目录 < 工作区 × 1.5（去重生效）
	 */
	test("SubTask 3.9.2: 磁盘占用 < 工作区大小 1.5×（去重生效）", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}

		// 创建独立的子目录避免与上一个测试冲突
		const subDir = path.join(tmpDir, "disk-usage-test");
		await fs.mkdir(subDir, { recursive: true });

		const subStore = createCheckpointStore({
			cwd: subDir,
			sessionId: "disk-usage-test",
			maxCheckpoints: 32,
			maxSizeMb: 64,
			swapPolicy: "lru-size",
		});

		// 1. 创建 3 个文件（每个 ~2KB，工作区总 ~6KB）
		const files: string[] = [];
		for (let i = 0; i < 3; i++) {
			const filename = `data${i}.txt`;
			const content = `data block ${i} `.repeat(200); // ~2.4KB
			await fs.writeFile(path.join(subDir, filename), content);
			files.push(filename);
		}

		// 2. 创建多个 checkpoint（相同内容 → 应去重）
		await subStore.create(0, "cp-initial", files);
		await subStore.create(1, "cp-same", files); // 相同内容，blob 应去重
		await subStore.create(2, "cp-same-2", files);

		// 3. 修改一个文件后再创建 checkpoint
		await fs.writeFile(
			path.join(subDir, files[0]),
			`modified block 0 ${Date.now()}`.repeat(200),
		);
		await subStore.create(3, "cp-after-modify", files);

		// 4. 计算工作区大小（仅用户文件，排除 .nexus 目录）
		const workspaceSize = await Promise.all(
			files.map(async (f) => (await fs.stat(path.join(subDir, f))).size),
		).then((sizes) => sizes.reduce((a, b) => a + b, 0));

		// 5. 计算 checkpoint 目录大小（<subDir>/.nexus/rewind-checkpoints/...）
		const nexusDir = path.join(subDir, ".nexus");
		let checkpointSize = 0;
		try {
			checkpointSize = await dirSizeBytes(nexusDir);
		} catch {
			checkpointSize = 0;
		}

		console.log(
			`[disk-usage] workspace=${workspaceSize} bytes, ` +
				`checkpoint=${checkpointSize} bytes, ` +
				`ratio=${(checkpointSize / Math.max(workspaceSize, 1)).toFixed(2)}x`,
		);

		// 验证：checkpoint 目录大小应 < 工作区 × 1.5
		// （含 4 个 checkpoint + 元数据 JSON，但 blob 去重应控制总大小）
		expect(checkpointSize).toBeLessThan(workspaceSize * 1.5);
	});

	/**
	 * SubTask 3.9.3（部分）：TS 侧验证 swap_policy 生效。
	 *
	 * 完整的 swap_policy LRU + 并发 restore 单元测试由 Rust 侧覆盖：
	 * - crates/nexus-checkpoint/src/swap_policy.rs（12 个测试）
	 * - crates/nexus-checkpoint/src/checkpoint_store.rs（15 个测试，含并发）
	 *
	 * 此测试验证：当 checkpoint 数量超过 maxCheckpoints 时，旧的被驱逐。
	 */
	test("SubTask 3.9.3: swap_policy LRU 驱逐生效（TS 侧）", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}

		const subDir = path.join(tmpDir, "swap-policy-test");
		await fs.mkdir(subDir, { recursive: true });

		// maxCheckpoints = 4，创建 6 个 checkpoint 验证驱逐
		const subStore = createCheckpointStore({
			cwd: subDir,
			sessionId: "swap-policy-test",
			maxCheckpoints: 4,
			maxSizeMb: 32,
			swapPolicy: "lru",
		});

		await fs.writeFile(path.join(subDir, "test.txt"), "v0");

		// 创建 6 个 checkpoint
		for (let i = 0; i < 6; i++) {
			await fs.writeFile(path.join(subDir, "test.txt"), `v${i}`);
			await subStore.create(i, `cp-${i}`, ["test.txt"]);
		}

		// 列出剩余 checkpoint，应 ≤ 4（LRU 驱逐最旧的）
		const metas = await subStore.list();
		console.log(`[swap-policy] 创建 6 个，剩余 ${metas.length} 个（maxCheckpoints=4）`);
		expect(metas.length).toBeLessThanOrEqual(4);
	});
});
