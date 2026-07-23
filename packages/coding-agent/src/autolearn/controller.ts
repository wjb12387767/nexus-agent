/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and, after a substantive turn,
 * optionally auto-runs a synthetic capture turn. Passive mode is intentionally
 * prompt-cache neutral: the standing system guidance remains available, but no
 * hidden mid-session reminder is inserted into the conversation.
 *
 * Installed once per top-level session (taskDepth 0). The subscription lives
 * for the session's lifetime — `newSession` resets the session in place
 * without re-running startup — so the controller needs no disposal.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	type CuratorConfig,
	DEFAULT_CURATOR_CONFIG,
	runCuratorReview,
	shouldRunNow,
} from "../curator";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnNudgeAutoContinue.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than live settings: the `learn`/`manage_skill`
 * registry is built ONCE at session start (and only for top-level sessions), so
 * keying the guidance on `autolearn.enabled` would let a mid-session enable — or
 * a subagent that filtered the tools out — inject guidance pointing at tools the
 * session never built. The `learn` addendum is included only when the `learn`
 * tool is present (it requires a memory backend).
 */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnGuidance.trim()];
	if (available.learn) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	capture: (content: string) => Promise<void>;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Prevent overlapping private capture runs while real primary turns continue. */
	#captureInFlight = false;
	/** One newer eligible primary stop arrived while capture was running. */
	#capturePending = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// Capture goal-mode state at the turn boundary, before any tool runs.
			this.#turnStartedInGoalMode = this.#session.getGoalModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		// Snapshot the turn-start goal flag alongside the counter so a turn that
		// observed no agent_start can never inherit a stale value.
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;

		// Never nudge a turn that ended in an abort (ESC, cancel, etc.). The
		// abort flag on the session is unreliable by the time agent_end is
		// deferred to subscribers; read stopReason from the event messages.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		// A2 Curator: independent of autolearn — runs on its own 7d cycle when
		// enabled. Fire-and-forget; failures never affect the primary loop.
		this.#maybeRunCurator();
		// Honor a live opt-out: the subscription outlives the setting, so re-check
		// the current flag rather than trusting install-time state.
		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;
		// Never divert a goal loop. Skip when the turn STARTED in goal mode — a
		// `goal` tool may have completed/dropped the goal before this stop — or is
		// still in it: a passive nudge would ride the goal continuation, and
		// auto-continue would compete with it.
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		// Auto-run a capture turn only when explicitly enabled. Passive mode used to
		// queue a hidden custom message for the next real turn, but that mutates the
		// persisted conversation prefix after providers have cached it. The standing
		// auto-learn system guidance is stable; keep passive mode to that guidance
		// so Anthropic prompt-cache prefixes survive long sessions.
		const autoContinue = this.#settings.get("autolearn.autoContinue") === true;
		if (!autoContinue) return;

		if (this.#captureInFlight) {
			this.#capturePending = true;
			return;
		}
		this.#startCapture();
	}

	/**
	 * A2 Curator 集成入口：读取 curator 设置，调用 shouldRunNow，true 时
	 * fire-and-forget 调用 runCuratorReview。失败静默吞掉。
	 *
	 * 与 autolearn 主流程独立：curator 不需要 capture 完成，也不阻塞下一轮。
	 */
	#maybeRunCurator(): void {
		try {
			if (!this.#settings.get("curator.enabled")) return;
			const config: CuratorConfig = {
				...DEFAULT_CURATOR_CONFIG,
				enabled: true,
				intervalHours: this.#settings.get("curator.intervalHours") ?? DEFAULT_CURATOR_CONFIG.intervalHours,
				staleAfterDays: this.#settings.get("curator.staleAfterDays") ?? DEFAULT_CURATOR_CONFIG.staleAfterDays,
				archiveAfterDays: this.#settings.get("curator.archiveAfterDays") ?? DEFAULT_CURATOR_CONFIG.archiveAfterDays,
			};
			// shouldRunNow 会在 last_run_at 为 null 时就地 seed state；这里通过
			// runCuratorReview 内部加载并 seed，故先用一个临时 state 探测是否需要运行。
			// 真正的 state 加载/seed/run 都在 runCuratorReview 内完成。
			void (async () => {
				try {
					// 加载 state（与 runCuratorReview 共享路径）以决定是否运行
					const { loadCuratorState, defaultCuratorStatePath } = await import("../curator");
					const statePath = config.statePath ?? defaultCuratorStatePath();
					const state = await loadCuratorState(statePath);
					const now = new Date();
					if (!shouldRunNow(state, config, now)) {
						// 首次 seed 后需要持久化（shouldRunNow 已就地修改 state）
						const { saveCuratorState } = await import("../curator");
						await saveCuratorState(statePath, state).catch(err => {
							logger.debug("curator state save (seed) failed", { err: err instanceof Error ? err.message : String(err) });
						});
						return;
					}
					await runCuratorReview(config, {
						onSummary: summary => {
							logger.debug("curator review summary", { summary });
						},
					});
				} catch (err) {
					logger.debug("curator review failed", { err: err instanceof Error ? err.message : String(err) });
				}
			})();
		} catch (err) {
			logger.debug("curator setup failed", { err: err instanceof Error ? err.message : String(err) });
		}
	}

	#startCapture(): void {
		this.#captureInFlight = true;
		void this.#capture(AUTOLEARN_NUDGE_AUTOCONTINUE)
			.catch(err => {
				logger.warn("auto-learn capture failed", { err });
			})
			.finally(() => {
				this.#captureInFlight = false;
				if (!this.#capturePending) return;
				this.#capturePending = false;
				this.#startCapture();
			});
	}
}
