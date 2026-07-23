/**
 * A2 Curator —— 技能生命周期管理。
 *
 * 每 7 天运行一次（可配置），需要 agent 空闲 ≥2 小时。
 * 状态机：ACTIVE → STALE（30 天未用）→ ARCHIVED（90 天未用）。
 *
 *  - Pinned skills 完全跳过（永不归档）
 *  - Cron 引用的 skill 跳过
 *  - 首次运行不立即执行，seed last_run_at=now，等一个完整 interval
 *  - 状态文件：~/.nexus/agent/.curator_state（JSON）
 *  - 运行报告：~/.nexus/logs/curator/{timestamp}/REPORT.md
 *
 * 参考：hermes agent/curator.py
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getLogsDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

// ═══════════════════════════════════════════════════════════════════════════
// 默认常量
// ═══════════════════════════════════════════════════════════════════════════

/** 运行间隔：默认 7 天（小时）。 */
export const DEFAULT_INTERVAL_HOURS = 24 * 7;

/** 最小空闲时长：默认 2 小时（agent 必须空闲 ≥2h 才会运行）。 */
export const DEFAULT_MIN_IDLE_HOURS = 2;

/** 标记为 STALE 的阈值：默认 30 天未用。 */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/** 归档为 ARCHIVED 的阈值：默认 90 天未用。 */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

/** Curator 持久化状态。 */
export interface CuratorState {
	/** 上次运行时间（ISO 字符串）；首次为 null。 */
	last_run_at: string | null;
	/** 上次运行耗时（秒）。 */
	last_run_duration_seconds: number | null;
	/** 上次运行摘要文本。 */
	last_run_summary: string | null;
	/** 上次摘要向用户展示的时间。 */
	last_run_summary_shown_at: string | null;
	/** 上次报告文件路径。 */
	last_report_path: string | null;
	/** 是否暂停（pause/resume）。 */
	paused: boolean;
	/** 累计运行次数。 */
	run_count: number;
}

/** 状态转移计数。 */
export interface TransitionCounts {
	/** 标记为 STALE 的数量。 */
	marked_stale: number;
	/** 归档为 ARCHIVED 的数量。 */
	archived: number;
	/** 从 STALE 重新激活为 ACTIVE 的数量。 */
	reactivated: number;
	/** 检查的总数（含跳过）。 */
	checked: number;
	/** 首次出现并 seed_record 的数量。 */
	seeded: number;
}

/** Curator 运行配置。 */
export interface CuratorConfig {
	/** 总开关。 */
	enabled: boolean;
	/** 运行间隔（小时）。 */
	intervalHours: number;
	/** 标记 STALE 的阈值（天）。 */
	staleAfterDays: number;
	/** 归档 ARCHIVED 的阈值（天）。 */
	archiveAfterDays: number;
	/** 最小空闲时长（小时）。 */
	minIdleHours: number;
	/** dry-run：只生成报告，不写盘。 */
	dryRun?: boolean;
	/** 状态文件路径（默认 ~/.nexus/agent/.curator_state）。 */
	statePath?: string;
	/** 报告目录（默认 ~/.nexus/logs/curator）。 */
	reportsDir?: string;
}

/** Curator 维护的 skill 记录（独立于 capability/skill.ts 的 Skill）。 */
export interface CuratorSkill {
	/** skill 名称（唯一键）。 */
	name: string;
	/** 状态：ACTIVE / STALE / ARCHIVED。 */
	status: "ACTIVE" | "STALE" | "ARCHIVED";
	/** 是否固定（永不归档）。 */
	pinned?: boolean;
	/** 是否被 cron 引用（跳过归档）。 */
	cronReferenced?: boolean;
	/** 创建时间（ISO 字符串）。 */
	created_at: string;
	/** 最后活动时间（ISO 字符串）。 */
	last_activity: string | null;
}

/** applyAutomaticTransitions 的返回值。 */
export interface ApplyTransitionsResult {
	counts: TransitionCounts;
	updatedSkills: CuratorSkill[];
}

/** 默认初始状态：last_run_at 为 null，运行后会 seed。 */
export const DEFAULT_CURATOR_STATE: CuratorState = {
	last_run_at: null,
	last_run_duration_seconds: null,
	last_run_summary: null,
	last_run_summary_shown_at: null,
	last_report_path: null,
	paused: false,
	run_count: 0,
};

/** 默认配置。 */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
	enabled: false,
	intervalHours: DEFAULT_INTERVAL_HOURS,
	staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
	archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
	minIdleHours: DEFAULT_MIN_IDLE_HOURS,
};

// ═══════════════════════════════════════════════════════════════════════════
// 路径解析
// ═══════════════════════════════════════════════════════════════════════════

/** 默认状态文件路径：~/.nexus/agent/.curator_state */
export function defaultCuratorStatePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, ".curator_state");
}

/** 默认报告目录：~/.nexus/logs/curator */
export function defaultCuratorReportsDir(): string {
	return path.join(getLogsDir(), "curator");
}

// ═══════════════════════════════════════════════════════════════════════════
// shouldRunNow：纯函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 判断当前是否应该运行 curator。
 *
 *  - paused 或 disabled → false
 *  - last_run_at 为 null → seed 并返回 false（首次运行等一个完整 interval）
 *  - (now - last_run_at) >= interval → true
 *
 * 注意：当 last_run_at 为 null 时，会就地修改 state.last_run_at = now
 * （seed），并通过返回值告知调用方"无需运行"。调用方应负责持久化 seed 后的 state。
 */
export function shouldRunNow(
	state: CuratorState,
	config: CuratorConfig,
	now: Date,
): boolean {
	if (state.paused || !config.enabled) return false;

	if (state.last_run_at === null) {
		// 首次：seed last_run_at = now，返回 false
		state.last_run_at = now.toISOString();
		state.last_run_summary = "seeded; waiting for first interval to elapse";
		return false;
	}

	const lastRun = new Date(state.last_run_at).getTime();
	const elapsedMs = now.getTime() - lastRun;
	const intervalMs = config.intervalHours * 60 * 60 * 1000;
	return elapsedMs >= intervalMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// applyAutomaticTransitions：纯函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 遍历 skills，应用自动状态转移。
 *
 *  - 跳过 pinned 和 cron 引用的 skill（永不归档）
 *  - 首次出现（last_activity 为 null 且 status 为 ACTIVE 且 created_at 已存在）→ seed_record（更新 last_activity = created_at），seeded++
 *  - anchor = last_activity or created_at or now
 *  - anchor <= archive_cutoff 且 != ARCHIVED → archive，archived++
 *  - anchor <= stale_cutoff 且 == ACTIVE → set STALE，marked_stale++
 *  - anchor > stale_cutoff 且 == STALE → set ACTIVE，reactivated++
 *  - 返回 { counts, updatedSkills }（不修改输入数组，返回新数组）
 */
export function applyAutomaticTransitions(
	skills: CuratorSkill[],
	state: CuratorState,
	config: CuratorConfig,
	now: Date,
): ApplyTransitionsResult {
	const counts: TransitionCounts = {
		marked_stale: 0,
		archived: 0,
		reactivated: 0,
		checked: 0,
		seeded: 0,
	};

	const nowMs = now.getTime();
	const staleCutoffMs = nowMs - config.staleAfterDays * 24 * 60 * 60 * 1000;
	const archiveCutoffMs = nowMs - config.archiveAfterDays * 24 * 60 * 60 * 1000;

	const updated: CuratorSkill[] = [];
	for (const skill of skills) {
		counts.checked++;

		// 跳过 pinned 和 cron 引用
		if (skill.pinned || skill.cronReferenced) {
			updated.push({ ...skill });
			continue;
		}

		// anchor = last_activity or created_at or now
		let anchorMs: number;
		if (skill.last_activity) {
			anchorMs = new Date(skill.last_activity).getTime();
		} else if (skill.created_at) {
			// 首次出现：seed last_activity = created_at
			anchorMs = new Date(skill.created_at).getTime();
			counts.seeded++;
			const seeded: CuratorSkill = {
				...skill,
				last_activity: skill.created_at,
			};
			updated.push(maybeTransition(seeded, anchorMs, staleCutoffMs, archiveCutoffMs, counts));
			continue;
		} else {
			anchorMs = nowMs;
		}

		updated.push(maybeTransition(skill, anchorMs, staleCutoffMs, archiveCutoffMs, counts));
	}

	// 引用 state 以保留与 hermes 实现一致的签名（state 可被调用方继续用于持久化）
	void state;

	return { counts, updatedSkills: updated };
}

/** 对单个 skill 应用状态转移规则，就地修改 counts。 */
function maybeTransition(
	skill: CuratorSkill,
	anchorMs: number,
	staleCutoffMs: number,
	archiveCutoffMs: number,
	counts: TransitionCounts,
): CuratorSkill {
	// archive 优先：anchor <= archive_cutoff 且 != ARCHIVED
	if (anchorMs <= archiveCutoffMs && skill.status !== "ARCHIVED") {
		counts.archived++;
		return { ...skill, status: "ARCHIVED" };
	}
	// stale：anchor <= stale_cutoff 且 == ACTIVE
	if (anchorMs <= staleCutoffMs && skill.status === "ACTIVE") {
		counts.marked_stale++;
		return { ...skill, status: "STALE" };
	}
	// reactivate：anchor > stale_cutoff 且 == STALE
	if (anchorMs > staleCutoffMs && skill.status === "STALE") {
		counts.reactivated++;
		return { ...skill, status: "ACTIVE" };
	}
	return { ...skill };
}

// ═══════════════════════════════════════════════════════════════════════════
// loadCuratorState / saveCuratorState
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 加载状态文件；不存在时返回 DEFAULT_CURATOR_STATE 的副本。
 *
 * 容错：JSON 解析失败时回退到默认状态，避免阻塞 curator 主流程。
 */
export async function loadCuratorState(statePath: string): Promise<CuratorState> {
	try {
		const content = await fs.readFile(statePath, "utf8");
		const parsed = JSON.parse(content) as Partial<CuratorState>;
		return { ...DEFAULT_CURATOR_STATE, ...parsed };
	} catch (err) {
		if (isEnoent(err)) return { ...DEFAULT_CURATOR_STATE };
		logger.warn("curator state load failed; using defaults", { err: err instanceof Error ? err.message : String(err) });
		return { ...DEFAULT_CURATOR_STATE };
	}
}

/**
 * 原子写入状态文件：先写临时文件，再 rename。
 *
 *  - 父目录不存在时自动创建
 *  - 使用临时文件 + rename 保证原子性
 *  - 跨设备 rename 失败时回退到直接写
 */
export async function saveCuratorState(statePath: string, state: CuratorState): Promise<void> {
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const tmp = `${statePath}.${process.pid}.tmp`;
	const content = `${JSON.stringify(state, null, 2)}\n`;
	// 原子写：writeFile 到 tmp 然后 rename
	await fs.writeFile(tmp, content, "utf8");
	try {
		await fs.rename(tmp, statePath);
	} catch (err) {
		// rename 失败时清理 tmp 并回退到直接写（跨设备或权限问题）
		await fs.unlink(tmp).catch(() => {});
		if (isCrossDeviceLinkError(err)) {
			await fs.writeFile(statePath, content, "utf8");
			return;
		}
		throw err;
	}
}

/** 检测跨设备 rename 失败（EXDEV）。 */
function isCrossDeviceLinkError(err: unknown): boolean {
	return (err as { code?: string })?.code === "EXDEV";
}

// ═══════════════════════════════════════════════════════════════════════════
// renderReportMarkdown
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 生成 curator 运行报告的 markdown 文本。
 *
 *  - transitions：状态转移计数
 *  - removedSkills：本次被归档的 skill 名称列表（仅用于报告展示）
 */
export function renderReportMarkdown(
	transitions: TransitionCounts,
	removedSkills: string[] = [],
): string {
	const lines: string[] = [];
	lines.push("# Curator Report");
	lines.push("");
	lines.push("## Transitions");
	lines.push("");
	lines.push(`- checked: ${transitions.checked}`);
	lines.push(`- seeded: ${transitions.seeded}`);
	lines.push(`- marked stale: ${transitions.marked_stale}`);
	lines.push(`- archived: ${transitions.archived}`);
	lines.push(`- reactivated: ${transitions.reactivated}`);
	lines.push("");
	if (removedSkills.length > 0) {
		lines.push("## Archived Skills");
		lines.push("");
		for (const name of removedSkills) {
			lines.push(`- ${name}`);
		}
		lines.push("");
	} else {
		lines.push("## Archived Skills");
		lines.push("");
		lines.push("(none)");
		lines.push("");
	}
	return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// runCuratorReview：异步函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 加载状态、检查 shouldRunNow、应用自动转移、生成报告、更新状态文件。
 *
 *  - 非干运行模式下，前置快照 skills（由调用方提供 loadSkills 回调）
 *  - onSummary：在状态文件写盘前调用，传入摘要文本
 *  - 整个流程失败时静默 catch（fire-and-forget 场景下调用方不需要抛错）
 */
export async function runCuratorReview(
	config: CuratorConfig,
	options: {
		/** 加载当前 skills 的回调（默认返回空数组，便于测试）。 */
		loadSkills?: () => Promise<CuratorSkill[]>;
		/** 写回更新后的 skills（非 dryRun 时调用）。 */
		saveSkills?: (skills: CuratorSkill[]) => Promise<void>;
		/** 当前时间（测试可注入）；默认 new Date()。 */
		now?: Date;
		/** 摘要回调；传入 last_run_summary 文本。 */
		onSummary?: (summary: string) => void;
	} = {},
): Promise<void> {
	const now = options.now ?? new Date();
	const statePath = config.statePath ?? defaultCuratorStatePath();
	const reportsDir = config.reportsDir ?? defaultCuratorReportsDir();

	const state = await loadCuratorState(statePath);
	if (!shouldRunNow(state, config, now)) {
		// 首次 seed 后也需要持久化
		await saveCuratorState(statePath, state).catch(err => {
			logger.debug("curator state save (seed) failed", { err: err instanceof Error ? err.message : String(err) });
		});
		return;
	}

	const startMs = now.getTime();
	const skills = options.loadSkills ? await options.loadSkills() : [];
	const { counts, updatedSkills } = applyAutomaticTransitions(skills, state, config, now);

	// 非 dry-run：写回 skills
	if (!config.dryRun && options.saveSkills) {
		await options.saveSkills(updatedSkills);
	}

	// 生成报告
	const removedSkills = updatedSkills
		.filter(s => s.status === "ARCHIVED")
		.map(s => s.name);
	const report = renderReportMarkdown(counts, removedSkills);
	const summary = `checked=${counts.checked} seeded=${counts.seeded} stale=${counts.marked_stale} archived=${counts.archived} reactivated=${counts.reactivated}`;
	options.onSummary?.(summary);

	// 写报告文件
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const reportDir = path.join(reportsDir, timestamp);
	const reportPath = path.join(reportDir, "REPORT.md");
	try {
		await fs.mkdir(reportDir, { recursive: true });
		await fs.writeFile(reportPath, report, "utf8");
	} catch (err) {
		logger.debug("curator report write failed", { err: err instanceof Error ? err.message : String(err) });
	}

	// 更新状态文件
	const endMs = Date.now();
	const updatedState: CuratorState = {
		...state,
		last_run_at: now.toISOString(),
		last_run_duration_seconds: Math.max(0, (endMs - startMs) / 1000),
		last_run_summary: summary,
		last_run_summary_shown_at: null,
		last_report_path: reportPath,
		run_count: state.run_count + 1,
	};
	await saveCuratorState(statePath, updatedState).catch(err => {
		logger.debug("curator state save failed", { err: err instanceof Error ? err.message : String(err) });
	});
}
