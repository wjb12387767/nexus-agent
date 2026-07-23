/**
 * A1 Background Review —— 每轮结束后的异步自反思。
 *
 * 在 agent 每轮 turn 结束后通过 onTurnEnd hook 触发，fire-and-forget
 * 启动一个轻量 review：用一个 fork/子 agent 重放最近对话，评估是否有
 * 值得保存的 memory 或值得创建/更新的 skill。
 *
 * 设计要点：
 *  - review agent 工具白名单：只允许 memory + skill_manage
 *  - 通知模式：off / on / verbose（默认 on）
 *  - 同模型路径（默认）：复用父 agent 的 runtime（热缓存）
 *  - 不同模型路径（auxModel 设置）：digest 历史（保留最后 digestTail 条 + older 摘要）
 *  - 失败静默（catch 所有错误，logger.debug 记录）
 *
 * 参考：hermes agent/background_review.py
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

/** 后台 review 的运行配置。 */
export interface BackgroundReviewConfig {
	/** 总开关；默认 false，关闭时所有 hook 短路返回。 */
	enabled: boolean;
	/**
	 * 通知模式：
	 *  - off：不显示任何 review 结果
	 *  - on：仅显示 created/updated/patched 摘要
	 *  - verbose：带预览（max 120 字符）
	 */
	notificationMode: "off" | "on" | "verbose";
	/** 可选辅助模型；设置后走 digest 路径而非热缓存路径。 */
	auxModel?: string;
	/** review agent 最大迭代次数；默认 16。 */
	maxIterations: number;
	/** digest 保留的尾部消息条数；默认 24。 */
	digestTail: number;
}

/** 默认配置：禁用、通知 on、最大 16 轮、digest 尾部 24 条。 */
export const DEFAULT_BACKGROUND_REVIEW_CONFIG: BackgroundReviewConfig = {
	enabled: false,
	notificationMode: "on",
	auxModel: undefined,
	maxIterations: 16,
	digestTail: 24,
};

/**
 * spawnBackgroundReview 所需的最小 agent 接口。
 *
 * 实际的 AgentSession 满足该接口；测试可注入 mock。
 * 可选的 spawnReviewTurn 由集成层提供，用于真正启动 review 子 agent；
 * 若未提供，spawnBackgroundReview 仅做消息构造并静默返回。
 */
export interface BackgroundReviewAgent {
	/** 当前会话消息快照（review 重放的输入）。 */
	readonly messages: readonly AgentMessage[];
	/** 当前会话 id。 */
	readonly sessionId: string;
	/** 父会话 id（fork 场景）。 */
	readonly parentSessionId?: string;
	/**
	 * 可选：真正启动一个 review 子 turn。
	 *
	 * 集成层注入：传入白名单过滤后的 review 消息，返回 review agent
	 * 产生的消息流（包含 tool_calls）。失败由 spawnBackgroundReview 静默吞掉。
	 */
	spawnReviewTurn?: (reviewMessages: AgentMessage[], config: BackgroundReviewConfig) => Promise<AgentMessage[]>;
	/** 可选：在 UI 上显示通知；若未提供则降级为 logger。 */
	notify?: (level: "info" | "warning" | "error", message: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具白名单
// ═══════════════════════════════════════════════════════════════════════════

/**
 * review agent 工具白名单：只允许 memory + skill_manage 系列。
 *
 * 集成层在构造子 agent 时应据此过滤工具集，禁止 review agent 调用
 * 任何能修改文件系统/执行命令的工具。
 */
export const REVIEW_TOOL_WHITELIST: ReadonlySet<string> = new Set([
	"memory",
	"memory_edit",
	"memory_search",
	"recall",
	"retain",
	"reflect",
	"skill_manage",
	"manage_skill",
]);

// ═══════════════════════════════════════════════════════════════════════════
// Prompt 常量
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Memory review prompt：评估对话中是否有值得保存的 memory。
 *
 * 关注：用户偏好、稳定事实、关键决策、长期上下文。
 * 禁止捕获：environment-dependent failures / negative claims /
 *           transient errors / one-off narratives。
 */
export const MEMORY_REVIEW_PROMPT = `You are a memory review agent. Re-evaluate the recent conversation and decide whether any durable memory should be saved.

Allowed tools: memory / memory_edit / recall / retain / reflect ONLY.

Save memory ONLY for:
- User preferences that will hold across future sessions
- Stable facts about the user, project, or environment
- Key decisions and the rationale behind them
- Long-lived context the agent should not have to rediscover

DO NOT capture:
- Environment-dependent failures (missing binaries, broken networks, transient state)
- Negative claims ("the user does not like X" without strong evidence)
- Transient errors or one-off narratives
- Anything already implied by existing memory

If nothing is worth saving, exit without calling any tool.`;

/**
 * Skill review prompt：评估对话中是否有值得创建/更新的 skill。
 *
 * 四档优先级（高到低）：
 *   1. UPDATE loaded —— 已加载的 skill 需要更新
 *   2. UPDATE umbrella —— 已加载的 umbrella skill 需要扩展覆盖
 *   3. ADD support file —— 在已加载 skill 下补充支持文件
 *   4. CREATE new —— 创建全新 skill
 *
 * 禁止捕获：environment-dependent failures / negative claims /
 *           transient errors / one-off narratives。
 */
export const SKILL_REVIEW_PROMPT = `You are a skill review agent. Re-evaluate the recent conversation and decide whether any skill should be created or updated.

Allowed tools: skill_manage / manage_skill ONLY.

Apply the following priority order (highest first); stop at the first applicable action:
  1. UPDATE loaded —— an already-loaded skill needs to be updated to reflect new findings
  2. UPDATE umbrella —— an already-loaded umbrella skill should be broadened to cover this case
  3. ADD support file —— add a supporting file under an already-loaded skill's directory
  4. CREATE new —— create a brand-new skill for a genuinely reusable workflow

DO NOT capture:
- Environment-dependent failures (missing binaries, broken networks, transient state)
- Negative claims ("this workflow does not work") without a positive reusable alternative
- Transient errors or one-off narratives
- Workflows that duplicate an existing skill

If no skill action is warranted, exit without calling any tool.`;

/**
 * 组合 review prompt：同时评估 memory 与 skill。
 */
export const COMBINED_REVIEW_PROMPT = `${MEMORY_REVIEW_PROMPT}

---

${SKILL_REVIEW_PROMPT}

---

Evaluate memory first, then skill. Call only the whitelisted tools above. If neither is warranted, exit without calling any tool.`;

// ═══════════════════════════════════════════════════════════════════════════
// 主函数：spawnBackgroundReview
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在 agent 每轮 turn 结束后 fire-and-forget 启动一个轻量 review。
 *
 * 行为：
 *  - 不 await，不阻塞下一轮
 *  - 内部用 setTimeout 延迟 100ms 启动（让主循环先继续）
 *  - 工具白名单：只允许 memory + skill_manage（由集成层在 spawnReviewTurn 中过滤）
 *  - 同模型路径（auxModel 未设置）：复用父 agent 的 runtime，原样传入 messages
 *  - 不同模型路径（auxModel 设置）：digest 历史（保留最后 digestTail 条 + older 摘要）
 *  - 失败静默（catch 所有错误，logger.debug 记录）
 */
export function spawnBackgroundReview(
	agent: BackgroundReviewAgent,
	messages: AgentMessage[],
	config: BackgroundReviewConfig,
): void {
	if (!config.enabled) return;

	// fire-and-forget：setTimeout 不阻塞调用方
	setTimeout(() => {
		void (async () => {
			try {
				// 不同模型路径：digest 历史，避免重新热缓存父 agent 的全部上下文
				const reviewInput = config.auxModel
					? digestHistory(messages, config.digestTail)
					: messages;

				// 构造 review prompt 作为新的 user-role 消息追加在头部
				const reviewPrompt: UserMessage = {
					role: "user",
					content: COMBINED_REVIEW_PROMPT,
					attribution: "user",
					timestamp: Date.now(),
				};
				const reviewMessages: AgentMessage[] = [reviewPrompt, ...reviewInput];

				// 调用集成层注入的 spawnReviewTurn；不存在则静默返回
				const spawn = agent.spawnReviewTurn;
				if (!spawn) return;

				const reviewOutput = await spawn(reviewMessages, config);

				// 通知用户（按 notificationMode 控制详细程度）
				const mode = config.notificationMode;
				if (mode === "off") return;
				const summary = summarizeBackgroundReviewActions(
					reviewOutput,
					{ skills: [], memories: [] },
					mode,
				);
				if (!summary) return;
				agent.notify?.("info", `Background review: ${summary}`);
			} catch (err) {
				// 静默：review 失败绝不能影响主循环
				logger.debug("background review failed", { err: err instanceof Error ? err.message : String(err) });
			}
		})();
	}, 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// summarizeBackgroundReviewActions
// ═══════════════════════════════════════════════════════════════════════════

/** 在 review 消息流中收集到的动作摘要输入：保留 priorSnapshot 用于去重。 */
export interface BackgroundReviewSnapshot {
	skills: string[];
	memories: string[];
}

/**
 * 从 review agent 的 tool_calls 收集动作并生成人类可读的摘要。
 *
 *  - 只统计 memory + skill_manage 的成功调用（isError !== true）
 *  - 非 verbose 模式：仅展示 created/updated/patched
 *  - verbose 模式：带预览（max 120 字符）
 *  - 返回 " · ".join 去重保序的摘要字符串；空时返回空字符串
 *
 * priorSnapshot 用于在 verbose 模式下标注动作是否针对已存在的项。
 */
export function summarizeBackgroundReviewActions(
	reviewMessages: AgentMessage[],
	priorSnapshot: BackgroundReviewSnapshot,
	mode: "off" | "on" | "verbose",
): string {
	if (mode === "off") return "";

	const verbose = mode === "verbose";
	const priorSkills = new Set(priorSnapshot.skills);
	const priorMemories = new Set(priorSnapshot.memories);

	// 去重保序：用 seen 集合 + 数组维护顺序
	const seen = new Set<string>();
	const ordered: string[] = [];

	const push = (entry: string): void => {
		if (!entry || seen.has(entry)) return;
		seen.add(entry);
		ordered.push(entry);
	};

	for (const message of reviewMessages) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const toolCalls = extractToolCalls(assistant);
		const resultsById = indexToolResults(reviewMessages);

		for (const call of toolCalls) {
			if (!REVIEW_TOOL_WHITELIST.has(call.name)) continue;
			const result = resultsById.get(call.id);
			// 只统计成功的调用（结果未标记 isError）
			if (result?.isError) continue;

			const action = describeAction(call, result, verbose, priorSkills, priorMemories);
			push(action);
		}
	}

	return ordered.join(" · ");
}

/** 从 assistant 消息中提取所有 tool_call。 */
function extractToolCalls(message: AssistantMessage): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall") calls.push(block);
	}
	return calls;
}

/** 按 toolCallId 索引 tool result 消息。 */
function indexToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
	const map = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		map.set(result.toolCallId, result);
	}
	return map;
}

/** 判断 call.name 是否属于 memory 系列。 */
function isMemoryTool(name: string): boolean {
	return name === "memory" || name === "memory_edit" || name === "retain" || name === "recall" || name === "reflect";
}

/** 判断 call.name 是否属于 skill 系列。 */
function isSkillTool(name: string): boolean {
	return name === "skill_manage" || name === "manage_skill";
}

/**
 * 描述一个 review 动作。
 *
 * 非 verbose 模式：返回 "memory created: foo" / "skill updated: bar" 形式。
 * verbose 模式：附加预览，max 120 字符，并在目标已存在时标注 "(existing)"。
 */
function describeAction(
	call: ToolCall,
	result: ToolResultMessage | undefined,
	verbose: boolean,
	priorSkills: Set<string>,
	priorMemories: Set<string>,
): string {
	const args = call.arguments ?? {};
	const kind = isMemoryTool(call.name) ? "memory" : isSkillTool(call.name) ? "skill" : call.name;
	const verb = pickVerb(args);
	const targetName = pickName(args, result) ?? call.id;

	// priorSnapshot 标注：目标已在 review 之前存在
	const priorSet = isMemoryTool(call.name) ? priorMemories : isSkillTool(call.name) ? priorSkills : null;
	const existsAlready = priorSet ? priorSet.has(targetName) : false;

	let entry = `${kind} ${verb}: ${targetName}`;
	if (verbose) {
		if (existsAlready) entry += " (existing)";
		const preview = pickPreview(result);
		if (preview) {
			const trimmed = preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
			entry = `${entry} — ${trimmed}`;
		}
	}
	return entry;
}

/** 根据 args 推断动作动词：created / updated / patched / deleted / called。 */
function pickVerb(args: Record<string, unknown>): "created" | "updated" | "patched" | "deleted" | "called" {
	const action = typeof args.action === "string" ? args.action : undefined;
	const op = typeof args.op === "string" ? args.op : undefined;
	const method = typeof args.method === "string" ? args.method : undefined;
	const verb = action ?? op ?? method;
	if (verb === "create") return "created";
	if (verb === "update") return "updated";
	if (verb === "patch") return "patched";
	if (verb === "delete" || verb === "remove") return "deleted";
	// 默认：created（review 多为新增）
	return "created";
}

/** 从 args / result 中提取目标名称。 */
function pickName(args: Record<string, unknown>, result: ToolResultMessage | undefined): string | undefined {
	if (typeof args.name === "string" && args.name) return args.name;
	if (typeof args.id === "string" && args.id) return args.id;
	if (typeof args.key === "string" && args.key) return args.key;
	if (typeof args.skill === "string" && args.skill) return args.skill;
	if (result?.details && typeof result.details === "object") {
		const details = result.details as Record<string, unknown>;
		if (typeof details.name === "string") return details.name;
		if (typeof details.id === "string") return details.id;
	}
	return undefined;
}

/** 从 tool result 中提取预览文本。 */
function pickPreview(result: ToolResultMessage | undefined): string | undefined {
	if (!result) return undefined;
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			return block.text.replace(/\s+/g, " ").trim();
		}
	}
	return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// digestHistory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 折叠对话历史：保留最后 tail 条消息，older 消息折叠为单条 user-role digest。
 *
 * digest 文本规则：
 *  - USER 消息取前 300 字符
 *  - ASSISTANT 消息取前 200 字符 + [tools: name1, name2]
 *
 * 返回的消息顺序：digest user 消息（如果有 older 消息）+ 最后 tail 条原始消息。
 */
export function digestHistory(messages: AgentMessage[], tail: number): AgentMessage[] {
	if (messages.length <= tail) return [...messages];

	const older = messages.slice(0, messages.length - tail);
	const tailMessages = messages.slice(messages.length - tail);

	const digestLines: string[] = ["[digest of prior conversation]"];
	for (const message of older) {
		digestLines.push(digestOne(message));
	}

	const digestMessage: UserMessage = {
		role: "user",
		content: digestLines.join("\n\n"),
		attribution: "user",
		timestamp: Date.now(),
	};

	return [digestMessage, ...tailMessages];
}

/** 折叠单条消息为 digest 文本片段。 */
function digestOne(message: AgentMessage): string {
	if (message.role === "user") {
		const user = message as UserMessage;
		const text = userMessageText(user);
		return `USER: ${truncate(text, 300)}`;
	}
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		const text = assistantMessageText(assistant);
		const toolNames = assistant.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map(call => call.name);
		const toolsSuffix = toolNames.length > 0 ? ` [tools: ${toolNames.join(", ")}]` : "";
		return `ASSISTANT: ${truncate(text, 200)}${toolsSuffix}`;
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join(" ");
		return `TOOL_RESULT(${result.toolName}): ${truncate(text, 200)}`;
	}
	// developer / custom 等：取稳定字符串表示
	return `${String(message.role ?? "unknown")}: ${truncate(safeStringify(message), 200)}`;
}

/** 从 user 消息中提取纯文本。 */
function userMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

/** 从 assistant 消息中提取纯文本（忽略 thinking / toolCall 块）。 */
function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

/** 截断到 max 字符，超长时加省略号。 */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 安全 JSON 序列化（处理循环引用）。 */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// buildMemoryWriteMetadata
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构造 memory 写入时的元数据。
 *
 *  - 过滤 None / undefined / null 值（不写入元数据）
 *  - 始终包含 writtenAt（ISO 时间戳）
 *  - 其余字段：sessionId / parentSessionId / platform / toolName
 */
export function buildMemoryWriteMetadata(
	sessionId: string | undefined,
	parentSessionId: string | undefined,
	platform: string | undefined,
	toolName: string | undefined,
): Record<string, string> {
	const metadata: Record<string, string> = {
		writtenAt: new Date().toISOString(),
	};
	if (sessionId != null && sessionId !== "") metadata.sessionId = sessionId;
	if (parentSessionId != null && parentSessionId !== "") metadata.parentSessionId = parentSessionId;
	if (platform != null && platform !== "") metadata.platform = platform;
	if (toolName != null && toolName !== "") metadata.toolName = toolName;
	return metadata;
}
