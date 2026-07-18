/**
 * Nexus Checkpoint — TS 侧冒烟测试。
 *
 * 注意：完整功能测试需要 native addon（`nexus_checkpoint.<platform>-<arch>.node`）
 * 已构建。若 addon 未构建，本测试会跳过并打印提示。
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-checkpoint-test-"));
		// 写入测试文件
		await fs.writeFile(path.join(tmpDir, "a.txt"), "v0");
		await fs.writeFile(path.join(tmpDir, "b.txt"), "v0");

		store = createCheckpointStore({
			cwd: tmpDir,
			sessionId: "test-session",
			maxCheckpoints: 8,
			maxSizeMb: 16,
			swapPolicy: "lru",
		});
		addonAvailable = true;
	} catch (err) {
		console.warn(
			"[nexus-checkpoint test] Native addon 不可用，跳过测试。" +
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

describe("nexus-checkpoint native addon", () => {
	test("addon 加载成功或跳过", () => {
		if (!addonAvailable) {
			console.log("[skip] native addon 未构建");
			return;
		}
		expect(store).not.toBeNull();
	});

	test("create + restore 完整流程", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}
		// 创建 checkpoint 0（捕获 a.txt 和 b.txt）
		const id = await store.create(0, "before-edit", ["a.txt", "b.txt"]);
		expect(id).toBe(0);

		// 修改文件
		await fs.writeFile(path.join(tmpDir, "a.txt"), "v1");
		await fs.writeFile(path.join(tmpDir, "b.txt"), "v1");

		// 回滚
		const result = await store.restore(0);
		expect(result.success).toBe(true);
		expect(result.revertedFiles.length).toBeGreaterThan(0);

		// 验证文件已还原
		const aContent = await fs.readFile(path.join(tmpDir, "a.txt"), "utf-8");
		const bContent = await fs.readFile(path.join(tmpDir, "b.txt"), "utf-8");
		expect(aContent).toBe("v0");
		expect(bContent).toBe("v0");
	});

	test("list 返回元数据", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}
		await store.create(1, "cp-1", ["a.txt"]);
		const metas = await store.list();
		expect(metas.length).toBeGreaterThan(0);
		expect(metas.some((m) => m.label === "cp-1")).toBe(true);
	});

	test("diff 检测差异", async () => {
		if (!addonAvailable || !store || !tmpDir) {
			console.log("[skip] native addon 未构建");
			return;
		}
		// cp 10: 仅 a.txt
		await store.create(10, "cp-10", ["a.txt"]);
		// cp 11: a.txt 修改 + b.txt 删除
		await fs.writeFile(path.join(tmpDir, "a.txt"), "modified");
		await store.create(11, "cp-11", ["a.txt"]);

		const diff = await store.diff(10, 11);
		expect(diff.added.length + diff.modified.length + diff.removed.length).toBeGreaterThan(0);
	});
});
