/**
 * A2 Curator 单元测试。
 *
 * 覆盖：
 *  - shouldRunNow（首次 seed、间隔未到、间隔已到、paused、disabled）
 *  - applyAutomaticTransitions（pinned 跳过、cron 跳过、stale 标记、archive 归档、reactivate、首次 seed）
 *  - loadCuratorState / saveCuratorState（读写、atomic、不存在时回退）
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyAutomaticTransitions,
	DEFAULT_CURATOR_CONFIG,
	DEFAULT_CURATOR_STATE,
	type CuratorConfig,
	type CuratorSkill,
	type CuratorState,
	loadCuratorState,
	renderReportMarkdown,
	saveCuratorState,
	shouldRunNow,
} from "../src/curator";

// ═══════════════════════════════════════════════════════════════════════════
// 测试夹具
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date("2026-01-15T00:00:00.000Z");
const STALE_CUTOFF = new Date("2025-12-16T00:00:00.000Z"); // 30 天前
const ARCHIVE_CUTOFF = new Date("2025-10-17T00:00:00.000Z"); // 90 天前

function makeConfig(overrides: Partial<CuratorConfig> = {}): CuratorConfig {
	return {
		...DEFAULT_CURATOR_CONFIG,
		enabled: true,
		intervalHours: 168, // 7 天
		staleAfterDays: 30,
		archiveAfterDays: 90,
		...overrides,
	};
}

function makeSkill(overrides: Partial<CuratorSkill> = {}): CuratorSkill {
	return {
		name: "test-skill",
		status: "ACTIVE",
		created_at: "2025-06-01T00:00:00.000Z",
		last_activity: "2026-01-10T00:00:00.000Z",
		...overrides,
	};
}

function freshState(): CuratorState {
	return { ...DEFAULT_CURATOR_STATE };
}

// ═══════════════════════════════════════════════════════════════════════════
// shouldRunNow
// ═══════════════════════════════════════════════════════════════════════════

describe("shouldRunNow", () => {
	it("首次运行（last_run_at 为 null）：seed 并返回 false", () => {
		const state = freshState();
		const config = makeConfig();
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(false);
		// state 被就地 seed
		expect(state.last_run_at).toBe(NOW.toISOString());
		expect(state.last_run_summary).toContain("seeded");
	});

	it("间隔未到：返回 false", () => {
		const state = freshState();
		// 上次运行 1 天前
		state.last_run_at = new Date("2026-01-14T00:00:00.000Z").toISOString();
		const config = makeConfig({ intervalHours: 168 }); // 7 天间隔
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(false);
	});

	it("间隔已到：返回 true", () => {
		const state = freshState();
		// 上次运行 8 天前（超过 7 天间隔）
		state.last_run_at = new Date("2026-01-07T00:00:00.000Z").toISOString();
		const config = makeConfig({ intervalHours: 168 });
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(true);
	});

	it("paused 状态：即使间隔已到也返回 false", () => {
		const state = freshState();
		state.last_run_at = new Date("2026-01-01T00:00:00.000Z").toISOString(); // 14 天前
		state.paused = true;
		const config = makeConfig({ intervalHours: 168 });
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(false);
	});

	it("disabled config：返回 false", () => {
		const state = freshState();
		state.last_run_at = new Date("2026-01-01T00:00:00.000Z").toISOString();
		const config = makeConfig({ enabled: false });
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(false);
	});

	it("间隔恰好等于 interval：返回 true（>= 比较）", () => {
		const state = freshState();
		// 恰好 7 天前（168 小时 = 7 天）
		state.last_run_at = new Date("2026-01-08T00:00:00.000Z").toISOString();
		const config = makeConfig({ intervalHours: 168 });
		const result = shouldRunNow(state, config, NOW);
		expect(result).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyAutomaticTransitions
// ═══════════════════════════════════════════════════════════════════════════

describe("applyAutomaticTransitions", () => {
	const config = makeConfig();
	const state = freshState();

	it("pinned skill 完全跳过（永不归档）", () => {
		const skill = makeSkill({
			name: "pinned-skill",
			pinned: true,
			last_activity: ARCHIVE_CUTOFF.toISOString(), // 远超 90 天
			status: "ACTIVE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		// checked 计数仍递增
		expect(counts.checked).toBe(1);
		// 但没有状态转移
		expect(counts.archived).toBe(0);
		expect(counts.marked_stale).toBe(0);
		expect(updatedSkills[0].status).toBe("ACTIVE");
	});

	it("cron 引用的 skill 跳过", () => {
		const skill = makeSkill({
			name: "cron-skill",
			cronReferenced: true,
			last_activity: ARCHIVE_CUTOFF.toISOString(),
			status: "ACTIVE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.archived).toBe(0);
		expect(updatedSkills[0].status).toBe("ACTIVE");
	});

	it("stale 标记：anchor <= stale_cutoff 且 ACTIVE → STALE", () => {
		const skill = makeSkill({
			name: "stale-skill",
			last_activity: STALE_CUTOFF.toISOString(), // 30 天前
			status: "ACTIVE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.marked_stale).toBe(1);
		expect(updatedSkills[0].status).toBe("STALE");
	});

	it("archive 归档：anchor <= archive_cutoff 且 != ARCHIVED → ARCHIVED", () => {
		const skill = makeSkill({
			name: "archive-skill",
			last_activity: ARCHIVE_CUTOFF.toISOString(), // 90 天前
			status: "STALE", // 已经是 STALE，仍应被归档
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.archived).toBe(1);
		expect(updatedSkills[0].status).toBe("ARCHIVED");
	});

	it("archive 优先于 stale：anchor <= archive_cutoff 且 ACTIVE → ARCHIVED（不是 STALE）", () => {
		const skill = makeSkill({
			name: "direct-archive",
			last_activity: ARCHIVE_CUTOFF.toISOString(),
			status: "ACTIVE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.archived).toBe(1);
		expect(counts.marked_stale).toBe(0);
		expect(updatedSkills[0].status).toBe("ARCHIVED");
	});

	it("reactivate：anchor > stale_cutoff 且 STALE → ACTIVE", () => {
		const skill = makeSkill({
			name: "reactivate-skill",
			last_activity: "2026-01-10T00:00:00.000Z", // 最近活动
			status: "STALE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.reactivated).toBe(1);
		expect(updatedSkills[0].status).toBe("ACTIVE");
	});

	it("首次 seed：last_activity 为 null 且 created_at 存在 → seed_record", () => {
		const skill = makeSkill({
			name: "new-skill",
			last_activity: null,
			created_at: STALE_CUTOFF.toISOString(), // 30 天前创建
			status: "ACTIVE",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.seeded).toBe(1);
		// seed 后 anchor = created_at（30 天前），应该被标记为 STALE
		expect(updatedSkills[0].last_activity).toBe(STALE_CUTOFF.toISOString());
		expect(updatedSkills[0].status).toBe("STALE");
	});

	it("已是 ARCHIVED 的 skill 不再转移", () => {
		const skill = makeSkill({
			name: "already-archived",
			last_activity: ARCHIVE_CUTOFF.toISOString(),
			status: "ARCHIVED",
		});
		const { counts, updatedSkills } = applyAutomaticTransitions([skill], state, config, NOW);
		expect(counts.archived).toBe(0);
		expect(counts.marked_stale).toBe(0);
		expect(updatedSkills[0].status).toBe("ARCHIVED");
	});

	it("不修改输入数组，返回新数组", () => {
		const skill = makeSkill({ name: "immutable", last_activity: STALE_CUTOFF.toISOString(), status: "ACTIVE" });
		const original = [skill];
		const { updatedSkills } = applyAutomaticTransitions(original, state, config, NOW);
		// 原数组不变
		expect(original[0].status).toBe("ACTIVE");
		// 新数组中状态已变
		expect(updatedSkills[0].status).toBe("STALE");
		expect(updatedSkills[0]).not.toBe(original[0]);
	});

	it("空数组返回空结果", () => {
		const { counts, updatedSkills } = applyAutomaticTransitions([], state, config, NOW);
		expect(updatedSkills.length).toBe(0);
		expect(counts.checked).toBe(0);
	});

	it("混合场景：多个 skill 同时处理", () => {
		const skills: CuratorSkill[] = [
			makeSkill({ name: "pinned", pinned: true, last_activity: ARCHIVE_CUTOFF.toISOString(), status: "ACTIVE" }),
			makeSkill({ name: "stale", last_activity: STALE_CUTOFF.toISOString(), status: "ACTIVE" }),
			makeSkill({ name: "archive", last_activity: ARCHIVE_CUTOFF.toISOString(), status: "ACTIVE" }),
			makeSkill({ name: "recent", last_activity: "2026-01-10T00:00:00.000Z", status: "STALE" }),
		];
		const { counts } = applyAutomaticTransitions(skills, state, config, NOW);
		expect(counts.checked).toBe(4);
		expect(counts.marked_stale).toBe(1);
		expect(counts.archived).toBe(1);
		expect(counts.reactivated).toBe(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// loadCuratorState / saveCuratorState
// ═══════════════════════════════════════════════════════════════════════════

describe("loadCuratorState / saveCuratorState", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "curator-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	afterAll(async () => {
		// 兜底清理
	});

	it("load 不存在的文件 → 返回 DEFAULT_CURATOR_STATE", async () => {
		const statePath = path.join(tmpDir, "nonexistent.json");
		const state = await loadCuratorState(statePath);
		expect(state.last_run_at).toBeNull();
		expect(state.paused).toBe(false);
		expect(state.run_count).toBe(0);
	});

	it("save 然后 load → 往返一致", async () => {
		const statePath = path.join(tmpDir, "state.json");
		const original: CuratorState = {
			last_run_at: "2026-01-10T00:00:00.000Z",
			last_run_duration_seconds: 12.5,
			last_run_summary: "checked=5 archived=2",
			last_run_summary_shown_at: null,
			last_report_path: "/tmp/report.md",
			paused: false,
			run_count: 3,
		};
		await saveCuratorState(statePath, original);
		const loaded = await loadCuratorState(statePath);
		expect(loaded).toEqual(original);
	});

	it("save 自动创建父目录", async () => {
		const statePath = path.join(tmpDir, "nested", "deep", "state.json");
		const state = freshState();
		state.last_run_at = NOW.toISOString();
		await saveCuratorState(statePath, state);
		// 文件确实存在
		const content = await fs.readFile(statePath, "utf8");
		expect(JSON.parse(content).last_run_at).toBe(NOW.toISOString());
	});

	it("load 损坏的 JSON → 回退到默认值", async () => {
		const statePath = path.join(tmpDir, "corrupt.json");
		await fs.writeFile(statePath, "{invalid json content", "utf8");
		const state = await loadCuratorState(statePath);
		expect(state.last_run_at).toBeNull();
		expect(state.run_count).toBe(0);
	});

	it("save 写入是 JSON 格式且带换行", async () => {
		const statePath = path.join(tmpDir, "formatted.json");
		await saveCuratorState(statePath, freshState());
		const content = await fs.readFile(statePath, "utf8");
		// 应以换行结尾
		expect(content.endsWith("\n")).toBe(true);
		// 应为合法 JSON
		expect(() => JSON.parse(content)).not.toThrow();
	});

	it("save 覆盖已有文件", async () => {
		const statePath = path.join(tmpDir, "overwrite.json");
		const first: CuratorState = { ...freshState(), run_count: 1 };
		await saveCuratorState(statePath, first);
		const second: CuratorState = { ...freshState(), run_count: 99 };
		await saveCuratorState(statePath, second);
		const loaded = await loadCuratorState(statePath);
		expect(loaded.run_count).toBe(99);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// renderReportMarkdown
// ═══════════════════════════════════════════════════════════════════════════

describe("renderReportMarkdown", () => {
	it("生成包含所有计数的 markdown", () => {
		const report = renderReportMarkdown(
			{ marked_stale: 2, archived: 1, reactivated: 0, checked: 5, seeded: 1 },
			["old-skill"],
		);
		expect(report).toContain("# Curator Report");
		expect(report).toContain("checked: 5");
		expect(report).toContain("seeded: 1");
		expect(report).toContain("marked stale: 2");
		expect(report).toContain("archived: 1");
		expect(report).toContain("reactivated: 0");
	});

	it("removedSkills 为空时显示 (none)", () => {
		const report = renderReportMarkdown(
			{ marked_stale: 0, archived: 0, reactivated: 0, checked: 3, seeded: 0 },
			[],
		);
		expect(report).toContain("(none)");
	});

	it("removedSkills 列出归档的 skill 名称", () => {
		const report = renderReportMarkdown(
			{ marked_stale: 0, archived: 2, reactivated: 0, checked: 2, seeded: 0 },
			["skill-a", "skill-b"],
		);
		expect(report).toContain("- skill-a");
		expect(report).toContain("- skill-b");
	});
});
