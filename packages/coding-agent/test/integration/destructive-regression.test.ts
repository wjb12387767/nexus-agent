/**
 * Nexus Agent — 破坏性回归测试（Task 3.1）
 *
 * 端到端验证 sandbox + checkpoint + reflink + bash AST + compaction 的联动，
 * 确保任一子系统的破坏性变更（越界写、CoW 失效、危险命令绕过、compaction
 * 误删 checkpoint）都会被本测试捕获。
 *
 * 跳过条件（设计原则：NAPI 不可用时 skip 而非 fail，避免 CI 误报）：
 * - process.platform === "win32" → 跳过场景 1/2
 *     （Landlock/Seatbelt/reflink 在 Windows 不可用；ISO FS 降级路径
 *      由 nexus-sandbox 自身的单元测试覆盖）
 * - NAPI 模块 import 失败 → 跳过依赖该模块的场景
 * - bash AST 底层 pi-natives 不可用 → 跳过场景 3
 *     （parseForSecurity 会返回 aborted，无法验证 needs-approval 判定）
 *
 * 运行：
 *   bun --cwd=packages/coding-agent test test/integration/destructive-regression.test.ts
 *
 * 注：本测试在 Linux CI 上全量运行；本地 Windows 开发会自动跳过 OS 级场景。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// NAPI 模块懒加载
// ─────────────────────────────────────────────────────────────────────────────
// 使用顶层 await + try/catch 动态导入。若 native addon 未构建（如 Windows
// 开发机），import 会抛错并被捕获，对应模块保持 null，下游 describe.skipIf
// 据此跳过相关场景。
//
// 走相对路径而非包名导入，因为 coding-agent 的 package.json 未直接依赖
// @nexus-agent/checkpoint / @nexus-agent/compaction；workspace 解析在测试
// 场景下不稳定。相对路径在 monorepo 内永远可解析。

let sandboxMod: typeof import("../../../nexus-sandbox/src/index.ts") | null = null;
let checkpointMod: typeof import("../../../nexus-checkpoint/src/index.ts") | null = null;
let bashAstMod: typeof import("../../../nexus-bash-ast/src/index.ts") | null = null;
let compactionMod: typeof import("../../../nexus-compaction/src/index.ts") | null = null;

try {
	sandboxMod = await import("../../../nexus-sandbox/src/index.ts");
} catch {
	/* nexus-sandbox native addon 不可用 */
}

try {
	checkpointMod = await import("../../../nexus-checkpoint/src/index.ts");
} catch {
	/* nexus-checkpoint native addon 不可用 */
}

try {
	bashAstMod = await import("../../../nexus-bash-ast/src/index.ts");
} catch {
	/* nexus-bash-ast 加载失败（理论不应发生，纯 TS 包） */
}

try {
	compactionMod = await import("../../../nexus-compaction/src/index.ts");
} catch {
	/* nexus-compaction 加载失败（理论不应发生，纯 TS 包） */
}

// ─────────────────────────────────────────────────────────────────────────────
// 跳过条件
// ─────────────────────────────────────────────────────────────────────────────

const hasSandboxNapi = sandboxMod !== null;
const hasCheckpointNapi = checkpointMod !== null;
const hasCompaction = compactionMod !== null;
const skipOnWindows = process.platform === "win32";

/**
 * 检测 bash AST 是否真正可用。
 *
 * bash-ast 包本身是纯 TS，import 永远成功；但其底层 parseCommand 依赖
 * @oh-my-pi/pi-natives 的 parseBashCommand NAPI 函数。若 pi-natives
 * native addon 未构建，parseForSecurity 会返回 verdict=aborted。
 *
 * 这里调用 parseForSecurity("ls") 做运行时探测：返回 aborted 表示
 * NAPI 不可用，场景 3 必须跳过（否则无法验证 needs-approval 判定）。
 */
function detectBashAstAvailable(): boolean {
	if (!bashAstMod) return false;
	try {
		const result = bashAstMod.parseForSecurity("ls");
		// aborted=true 表示 NAPI 不可用或对抗性输入触发预算耗尽
		// 对 "ls" 这种简单命令，aborted 只可能由 NAPI 不可用导致
		return result.aborted !== true;
	} catch {
		return false;
	}
}

const bashAstAvailable = detectBashAstAvailable();

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：递归清理临时目录（best-effort，失败不阻断测试）
// ─────────────────────────────────────────────────────────────────────────────

async function cleanupDir(dir: string | null): Promise<void> {
	if (!dir) return;
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════════════════
// 测试主体
// ═════════════════════════════════════════════════════════════════════════════

describe("destructive regression: sandbox + checkpoint + reflink", () => {
	// ───────────────────────────────────────────────────────────────────────
	// 场景 1: sandbox 拒绝越界写 + checkpoint 恢复
	// ───────────────────────────────────────────────────────────────────────
	// 验证：
	//   - sandbox 阻止向工作区外路径写入（workspace profile 强制）
	//   - 越界写失败不会污染工作区内文件
	//   - checkpoint 可回滚工作区内文件的修改
	//
	// 跳过：Windows（Landlock/Seatbelt 不可用） + sandbox 或 checkpoint NAPI 缺失
	describe.skipIf(skipOnWindows || !hasSandboxNapi || !hasCheckpointNapi)(
		"场景 1: sandbox 拒绝越界写 + checkpoint 恢复",
		() => {
			test("sandbox 阻止工作区外写入，checkpoint 可回滚工作区内修改", async () => {
				if (!sandboxMod || !checkpointMod) return; // 类型收窄，skipIf 已保证

				const workspace = await mkdtemp(path.join(tmpdir(), "nexus-sbx-ws-"));
				const outsideDir = await mkdtemp(path.join(tmpdir(), "nexus-sbx-out-"));
				const outsideFile = path.join(outsideDir, "should-not-exist.txt");
				const insideFile = path.join(workspace, "inside.txt");

				try {
					// 1. 工作区内创建初始文件
					await writeFile(insideFile, "v0");

					// 2. 创建 checkpoint A（捕获 inside.txt 初始状态）
					const store = checkpointMod.createCheckpointStore({
						cwd: workspace,
						sessionId: "scenario-1-cross-write",
						maxCheckpoints: 8,
						maxSizeMb: 16,
						swapPolicy: "lru",
					});
					const cpId = await store.create(0, "before-cross-write", ["inside.txt"]);
					expect(cpId).toBe(0);

					// 3. 创建 sandbox（workspace profile：仅允许 workspace 内写入）
					const sb = sandboxMod.createSandbox("workspace", { workspace });

					// 4. 通过 sandbox.exec 尝试向工作区外路径写入
					//    exec 会在子进程中应用 Landlock/Seatbelt，子进程的越界写应失败
					//    使用 sh -c 让 shell 解析重定向，模拟真实攻击路径
					let execBlocked = false;
					try {
						const result = await sb.exec("sh", [
							"-c",
							`echo 'pwned' > "${outsideFile}"`,
						]);
						// 越界写应失败：exitCode != 0 或 stderr 含权限错误
						execBlocked = result.exitCode !== 0;
					} catch {
						// sandbox 直接抛错也算 blocked
						execBlocked = true;
					}

					// 5. 验证 outside 文件未被创建（双重保险：exec 返回值 + 文件系统实际状态）
					let outsideFileExists = false;
					try {
						await readFile(outsideFile, "utf-8");
						outsideFileExists = true;
					} catch {
						outsideFileExists = false;
					}

					// 至少一种阻断信号必须存在：exec 返回非零 / 抛错 / 文件未创建
					// 全部通过 → sandbox 失效，回归测试应 fail
					expect(execBlocked || !outsideFileExists).toBe(true);

					// 6. 修改工作区内文件（通过直接 fs 调用，测试进程本身未沙箱化）
					await writeFile(insideFile, "v1");
					expect(await readFile(insideFile, "utf-8")).toBe("v1");

					// 7. rewind 到 checkpoint A
					const restoreResult = await store.restore(0);
					expect(restoreResult.success).toBe(true);
					expect(restoreResult.revertedFiles.length).toBeGreaterThan(0);

					// 8. 验证 inside.txt 已恢复到 "v0"
					expect(await readFile(insideFile, "utf-8")).toBe("v0");

					// 9. 验证 outside 文件仍未被创建（sandbox 拒绝 + checkpoint 不影响工作区外）
					expect(outsideFileExists).toBe(false);
				} finally {
					await cleanupDir(workspace);
					await cleanupDir(outsideDir);
				}
			});
		},
	);

	// ───────────────────────────────────────────────────────────────────────
	// 场景 2: reflink CoW 隔离验证
	// ───────────────────────────────────────────────────────────────────────
	// 验证：
	//   - checkpoint 创建后，修改工作区文件不会改变 checkpoint 内快照
	//   - reflink CoW 让快照与工作区物理隔离（修改工作区不触发写时复制到快照）
	//   - restore(id) 能把工作区文件还原回快照内容
	//
	// 跳过：Windows（reflink 不可用，store.reflinkCapable 永远为 false）
	//       + checkpoint NAPI 缺失
	//
	// 注：在非 CoW FS（ext4/tmpfs）上 checkpoint 系统会退化为全量拷贝，
	//     逻辑隔离仍成立。本测试在 reflinkCapable=false 时记录日志但不 skip，
	//     以覆盖退化路径；如果场景 2 在 CI 上失败，先检查 FS 是否支持 CoW。
	describe.skipIf(skipOnWindows || !hasCheckpointNapi)(
		"场景 2: reflink CoW 隔离验证",
		() => {
			test("checkpoint 快照在文件修改后保持原始内容（CoW 隔离）", async () => {
				if (!checkpointMod) return; // 类型收窄

				const workspace = await mkdtemp(path.join(tmpdir(), "nexus-cow-ws-"));
				const fooFile = path.join(workspace, "foo.txt");

				try {
					// 1. 创建初始文件
					await writeFile(fooFile, "original");

					// 2. 创建 checkpoint A
					const store = checkpointMod.createCheckpointStore({
						cwd: workspace,
						sessionId: "scenario-2-cow",
						maxCheckpoints: 8,
						maxSizeMb: 16,
						swapPolicy: "lru",
					});

					// 记录 reflink 支持状态（诊断用，不强制 skip）
					const reflinkCapable = Boolean(store.reflinkCapable);
					console.log(
						`[scenario-2] reflinkCapable=${reflinkCapable}` +
							` (false 表示走全量拷贝退化路径，逻辑隔离仍应成立)`,
					);

					const cpId = await store.create(0, "before-modify", ["foo.txt"]);
					expect(cpId).toBe(0);

					// 3. 修改工作区文件
					await writeFile(fooFile, "modified");

					// 4. 验证当前工作区文件已被修改
					expect(await readFile(fooFile, "utf-8")).toBe("modified");

					// 5. restore 到 checkpoint A
					//    如果 CoW 隔离失效（即修改工作区时也修改了快照），
					//    restore 会还原出 "modified" 而非 "original"
					const restoreResult = await store.restore(0);
					expect(restoreResult.success).toBe(true);

					// 6. 验证工作区文件回到 "original" —— 证明快照在修改期间保持不变
					expect(await readFile(fooFile, "utf-8")).toBe("original");

					// 7. 验证 restore 报告了 foo.txt 被还原
					expect(restoreResult.revertedFiles).toContain("foo.txt");
				} finally {
					await cleanupDir(workspace);
				}
			});
		},
	);

	// ───────────────────────────────────────────────────────────────────────
	// 场景 3: sandbox + bash AST 联动
	// ───────────────────────────────────────────────────────────────────────
	// 验证：
	//   - bash AST 安全分析对 eval "rm -rf /" 返回 needs-approval
	//     （EVAL_LIKE_BUILTINS 检测：eval/source/exec/... 把参数当代码执行）
	//   - 双重防护：即使 approval 流程误批准，sandbox 仍会物理阻断 rm -rf /
	//     （此部分仅做静态验证：sandbox profile 在创建时即限制写入到 workspace，
	//      rm -rf / 试图删除工作区外文件，sb.exec 会失败）
	//
	// 跳过：bash AST 不可用（pi-natives 未加载，parseForSecurity 返回 aborted）
	//       不跳过 on Windows —— AST 分析是纯计算，不依赖 OS 沙箱
	describe.skipIf(!bashAstAvailable)("场景 3: sandbox + bash AST 联动", () => {
		test('parseForSecurity 对 `eval "rm -rf /"` 返回 needs-approval', () => {
			if (!bashAstMod) return; // 类型收窄

			// 危险命令：eval 把字符串参数当代码执行
			// argv 看起来是 ['eval', 'rm -rf /']，单看 argv 无害
			// walker 的 checkSemantics 检测到 argv[0]='eval' ∈ EVAL_LIKE_BUILTINS
			// → 标记 verdict='needs-approval'，防止绕过
			const result = bashAstMod.parseForSecurity('eval "rm -rf /"');

			// 核心断言：必须 needs-approval（不可 safe，不可 aborted）
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);

			// reason 应提及 eval（EVAL_LIKE_BUILTINS 触发）
			expect(result.reason).toMatch(/eval/i);

			// 验证 EVAL_LIKE_BUILTINS 集合确实包含 eval（防御集合被误删）
			expect(bashAstMod.EVAL_LIKE_BUILTINS.has("eval")).toBe(true);
		});

		test("AST 安全分析的 fail-closed 原则：未在 allowlist 的节点类型触发 needs-approval", () => {
			if (!bashAstMod) return;

			// `cat <(ls)` 使用 process_substitution。process_substitution 不在
			// walkCommand 的子节点 allowlist 中（command_name/word/string/
			// file_redirect/...）， walker 走 default 分支 → tooComplexNode
			// → verdict=needs-approval。这是 fail-closed 原则的体现：
			// 任何未显式 allow 的结构都按危险处理。
			const result = bashAstMod.parseForSecurity("cat <(ls)");
			expect(result.verdict).toBe("needs-approval");
			expect(result.aborted).toBe(false);
		});

		test.skipIf(skipOnWindows || !hasSandboxNapi)(
			"双重防护：sandbox 物理阻断 rm 越界删除（即使 AST 误批准）",
			async () => {
				if (!sandboxMod) return;

				// 模拟"AST 误批准"场景：直接用 sandbox.exec 运行 rm -rf /
				// 期望 sandbox profile 阻断对工作区外路径的删除操作
				const workspace = await mkdtemp(path.join(tmpdir(), "nexus-sbx-double-"));
				const outsideTarget = await mkdtemp(path.join(tmpdir(), "nexus-sbx-double-out-"));
				const outsideMarker = path.join(outsideTarget, "marker.txt");

				try {
					// 在 outside 目录放一个 marker 文件，验证 rm 未能删除它
					await writeFile(outsideMarker, "should-survive");

					const sb = sandboxMod.createSandbox("workspace", { workspace });

					// 尝试用 rm -rf 删除工作区外目录（这是 AST 应该拦截的危险操作）
					// 即使 approval 流程误批准，sandbox 必须物理阻断
					let blocked = false;
					try {
						const result = await sb.exec("rm", ["-rf", outsideTarget]);
						blocked = result.exitCode !== 0;
					} catch {
						blocked = true;
					}

					// 验证 marker 文件仍然存在（sandbox 阻断了 rm）
					let markerSurvived = false;
					try {
						const content = await readFile(outsideMarker, "utf-8");
						markerSurvived = content === "should-survive";
					} catch {
						markerSurvived = false;
					}

					// 至少一种阻断信号：exec 失败 / marker 存活
					expect(blocked || markerSurvived).toBe(true);
				} finally {
					await cleanupDir(workspace);
					await cleanupDir(outsideTarget);
				}
			},
		);
	});

	// ───────────────────────────────────────────────────────────────────────
	// 场景 4: compaction + checkpoint 联动
	// ───────────────────────────────────────────────────────────────────────
	// 验证：
	//   - compaction 处理消息列表时不影响磁盘上的 checkpoint store
	//   - compaction 后 checkpoint 仍可通过 list() 枚举
	//   - compaction 后仍可 restore(id) 回滚到 checkpoint
	//
	// 跳过：checkpoint NAPI 缺失 或 compaction 模块缺失
	//       不跳过 on Windows —— compaction 是纯 TS，checkpoint 在 Windows
	//       走全量拷贝退化路径，逻辑上仍应工作
	describe.skipIf(!hasCheckpointNapi || !hasCompaction)(
		"场景 4: compaction + checkpoint 联动",
		() => {
			test("compaction 后 checkpoint 仍可枚举与回滚", async () => {
				if (!checkpointMod || !compactionMod) return;

				const workspace = await mkdtemp(path.join(tmpdir(), "nexus-cmp-ws-"));
				const stateFile = path.join(workspace, "state.txt");

				try {
					// 1. 创建初始状态文件
					await writeFile(stateFile, "v0");

					// 2. 创建 checkpoint A（compaction 前的"安全点"）
					const store = checkpointMod.createCheckpointStore({
						cwd: workspace,
						sessionId: "scenario-4-compaction",
						maxCheckpoints: 8,
						maxSizeMb: 16,
						swapPolicy: "lru",
					});
					const cpId = await store.create(0, "before-compaction", ["state.txt"]);
					expect(cpId).toBe(0);

					// 3. 构造大量重复消息触发 compaction
					//    compaction 与 checkpoint store 是两个独立子系统：
					//    - compaction 操作内存消息列表
					//    - checkpoint store 操作磁盘文件快照
					//    验证 compaction 不会意外删除 checkpoint 元数据或 blob
					const repetitiveText = "重复内容 ".repeat(50);
					const largeCodeBlock = "```ts\n" + "const x = 1;\n".repeat(60) + "```";

					const messages = [
						{ role: "system", content: "你是 Nexus Agent", timestamp: 0 },
						{ role: "user", content: repetitiveText, timestamp: 1 },
						{
							role: "assistant",
							content: [{ type: "text", text: largeCodeBlock }],
							timestamp: 2,
						},
						{ role: "user", content: repetitiveText, timestamp: 3 },
						{
							role: "assistant",
							content: [{ type: "text", text: largeCodeBlock }],
							timestamp: 4,
						},
						{ role: "user", content: repetitiveText, timestamp: 5 },
					];

					// 4. 运行 nexus compaction（不注入 sampler，跳过 history 阶段）
					const tokensBefore = compactionMod.estimateMessagesTokens(messages);
					const compacted = await compactionMod.compact(messages, {
						config: {
							strategy: "nexus",
							interThreshold: 64,
							intraThreshold: 32,
							codeBlockSize: 20,
							historyTurns: Number.MAX_SAFE_INTEGER, // 禁用 history（无 sampler）
							userMessageTruncateChars: 3000,
							minCompactableTokens: 0,
							maxReductionRatio: 0.95,
							keepRecentTurns: 4,
						},
					});
					const tokensAfter = compacted.tokensAfter;

					// 验证 compaction 确实运行了（messages 数组可能缩减或不变，
					// 但 tokensAfter 应该 <= tokensBefore）
					expect(tokensAfter).toBeLessThanOrEqual(tokensBefore);
					expect(compacted.messages.length).toBeGreaterThan(0);

					// 5. 验证 checkpoint A 仍可枚举（compaction 未破坏 store）
					const metas = await store.list();
					expect(metas.length).toBeGreaterThan(0);
					expect(metas.some((m) => m.id === 0 && m.label === "before-compaction")).toBe(true);

					// 6. 修改工作区文件（compaction 后的状态变更）
					await writeFile(stateFile, "v1-after-compaction");

					// 7. rewind 到 checkpoint A（验证 compaction 后仍可回滚）
					const restoreResult = await store.restore(0);
					expect(restoreResult.success).toBe(true);
					expect(restoreResult.revertedFiles).toContain("state.txt");

					// 8. 验证文件已恢复到 compaction 前的状态
					expect(await readFile(stateFile, "utf-8")).toBe("v0");
				} finally {
					await cleanupDir(workspace);
				}
			});
		},
	);
});
