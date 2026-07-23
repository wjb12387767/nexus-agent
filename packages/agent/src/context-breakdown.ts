/**
 * 上下文使用分解可视化（B4 Context Breakdown）。
 *
 * 移植自 hermes-agent 的 `context_breakdown` 能力，提供 Cursor 风格的
 * 上下文使用分布。将当前上下文拆分为 8 类（system_prompt、tool_definitions、
 * rules、skills、mcp、subagent_definitions、memory、conversation），每类附带
 * CSS 变量颜色、标识、标签与估算 token 数。
 *
 * 估算方式采用轻量的 char/4 估算（`_charsToTokens`），与 hermes 保持一致，
 * 不依赖真实的 tokenizer——这样该模块可在 `@oh-my-pi/pi-agent-core` 中独立
 * 使用，无需引入编码器原生依赖。
 */

import type { AgentMessage } from "./types";

/** CSS 变量颜色，对应前端主题中的上下文用量色板。 */
export interface ContextCategoryColors {
	system_prompt: "var(--context-usage-system)";
	tool_definitions: "var(--context-usage-tools)";
	rules: "var(--context-usage-rules)";
	skills: "var(--context-usage-skills)";
	mcp: "var(--context-usage-mcp)";
	subagent_definitions: "var(--context-usage-subagents)";
	memory: "var(--context-usage-memory)";
	conversation: "var(--context-usage-conversation)";
}

/** 上下文分类标识。 */
export type ContextCategoryId = keyof ContextCategoryColors;

/** 单个上下文分类条目。 */
export interface ContextCategory {
	/** 分类标识 */
	id: ContextCategoryId;
	/** 展示标签 */
	label: string;
	/** 估算 token 数 */
	tokens: number;
	/** CSS 变量颜色字符串 */
	color: ContextCategoryColors[ContextCategoryId];
}

/** 上下文分解结果。 */
export interface ContextBreakdown {
	/** 8 类分类条目（按固定顺序） */
	categories: ContextCategory[];
	/** 模型上下文窗口上限（tokens），未知时为 0 */
	context_max: number;
	/** 上下文使用百分比（0-100），未知时为 0 */
	context_percent: number;
	/** 已使用的上下文 token 数（估算） */
	context_used: number;
	/** 估算的总 token 数（等于 context_used） */
	estimated_total: number;
	/** 模型名称 */
	model: string;
}

/**
 * AgentLike —— computeContextBreakdown 所需的最小 agent 视图。
 *
 * agent 包本身不感知 skills/mcp/subagents 等编码代理概念，因此这些字段全部
 * 可选；调用方（如 coding-agent）按需填充。未填充的分类记为 0 token。
 */
export interface AgentLike {
	/** 模型名称（如 "anthropic/claude-sonnet-4"） */
	model?: string;
	/** 模型上下文窗口上限（tokens） */
	contextWindow?: number;
	/** 系统提示词（字符串或字符串数组） */
	systemPrompt?: string | readonly string[];
	/** 工具定义列表（含 name/description/parameters 等） */
	tools?: ReadonlyArray<ToolDefinitionLike>;
	/** 规则文本列表 */
	rules?: readonly string[];
	/** 技能列表（含 name/description） */
	skills?: ReadonlyArray<SkillDefinitionLike>;
	/** MCP 工具定义列表 */
	mcpTools?: ReadonlyArray<ToolDefinitionLike>;
	/** 子代理定义列表 */
	subagents?: ReadonlyArray<SubagentDefinitionLike>;
	/** 注入的记忆文本（字符串或字符串数组） */
	memory?: string | readonly string[];
	/** 会话 id */
	session_id?: string;
	/** 上下文压缩器（保留字段，便于未来扩展） */
	context_compressor?: unknown;
}

/** 工具定义的最小视图。 */
export interface ToolDefinitionLike {
	name?: string;
	description?: string;
	parameters?: unknown;
	[key: string]: unknown;
}

/** 技能定义的最小视图。 */
export interface SkillDefinitionLike {
	name?: string;
	description?: string;
	[key: string]: unknown;
}

/** 子代理定义的最小视图。 */
export interface SubagentDefinitionLike {
	name?: string;
	description?: string;
	spawns?: unknown;
	tools?: unknown;
	[key: string]: unknown;
}

/** 8 类分类的固定顺序与展示标签。 */
const CATEGORY_ORDER: ReadonlyArray<{ id: ContextCategoryId; label: string }> = [
	{ id: "system_prompt", label: "System Prompt" },
	{ id: "tool_definitions", label: "Tool Definitions" },
	{ id: "rules", label: "Rules" },
	{ id: "skills", label: "Skills" },
	{ id: "mcp", label: "MCP" },
	{ id: "subagent_definitions", label: "Subagent Definitions" },
	{ id: "memory", label: "Memory" },
	{ id: "conversation", label: "Conversation" },
];

/** 各分类对应的 CSS 变量颜色。 */
const CATEGORY_COLORS: ContextCategoryColors = {
	system_prompt: "var(--context-usage-system)",
	tool_definitions: "var(--context-usage-tools)",
	rules: "var(--context-usage-rules)",
	skills: "var(--context-usage-skills)",
	mcp: "var(--context-usage-mcp)",
	subagent_definitions: "var(--context-usage-subagents)",
	memory: "var(--context-usage-memory)",
	conversation: "var(--context-usage-conversation)",
};

/**
 * char/4 估算：将字符长度近似为 token 数。
 *
 * `(length + 3) / 4` 向下取整，等价于对 4 字节向上凑整后再除 4，与 hermes
 * 的 `_charsToTokens` 实现一致。对空字符串返回 0。
 *
 * @param text 待估算的文本
 * @returns 估算 token 数
 */
export function _charsToTokens(text: string): number {
	return Math.floor((text.length + 3) / 4);
}

/**
 * 将任意可 JSON 序列化的值估算为 token 数。
 *
 * 先 `JSON.stringify` 再走 `_charsToTokens`。序列化失败时回退为 0。
 *
 * @param value 待估算的值
 * @returns 估算 token 数
 */
export function _jsonTokens(value: unknown): number {
	try {
		return _charsToTokens(JSON.stringify(value));
	} catch {
		return 0;
	}
}

/**
 * 将字符串或字符串数组拼接后估算 token 数。
 *
 * @param value 字符串或字符串数组
 * @returns 估算 token 数
 */
function _textTokens(value: string | readonly string[] | undefined): number {
	if (value === undefined) return 0;
	if (typeof value === "string") return _charsToTokens(value);
	return _charsToTokens(value.join("\n"));
}

/**
 * 粗略估算消息列表的 token 总量。
 *
 * 遍历 messages，累加每条消息可读内容的 char/4 估算值。与 hermes 的
 * `estimate_messages_tokens_rough` 行为一致：不调用真实 tokenizer，仅用于
 * 上下文分解可视化中的 conversation 分类估算。
 *
 * @param messages 消息列表
 * @returns 估算 token 数
 */
export function estimateMessagesTokensRough(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += _estimateMessageTokensRough(message);
	}
	return total;
}

/**
 * 估算单条消息的 token 数（char/4）。
 *
 * 处理 user/assistant 等常见角色的字符串与分块内容，其余角色回退为 JSON
 * 序列化估算。
 */
function _estimateMessageTokensRough(message: AgentMessage): number {
	const role = (message as { role?: string }).role;
	if (role === "user") {
		const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
		if (typeof content === "string") return _charsToTokens(content);
		if (Array.isArray(content)) {
			let sum = 0;
			for (const block of content) {
				if (block && block.type === "text" && typeof block.text === "string") sum += _charsToTokens(block.text);
			}
			return sum;
		}
		return _jsonTokens(content);
	}
	if (role === "assistant") {
		const content = (message as { content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> }).content;
		if (Array.isArray(content)) {
			let sum = 0;
			for (const block of content) {
				if (!block) continue;
				if (block.type === "text" && typeof block.text === "string") sum += _charsToTokens(block.text);
				else if (block.type === "toolCall") {
					if (typeof block.name === "string") sum += _charsToTokens(block.name);
					sum += _jsonTokens(block.arguments);
				}
			}
			return sum;
		}
		return _jsonTokens(content);
	}
	// 其余角色（tool 结果、bash 执行等）回退为 JSON 估算。
	return _jsonTokens(message);
}

/**
 * 估算工具定义列表的 token 数。
 *
 * 每个工具序列化为 JSON 后累加 char/4 估算。
 *
 * @param tools 工具定义列表
 * @returns 估算 token 数
 */
function _estimateToolsTokens(tools: ReadonlyArray<ToolDefinitionLike> | undefined): number {
	if (!tools || tools.length === 0) return 0;
	let total = 0;
	for (const tool of tools) total += _jsonTokens(tool);
	return total;
}

/**
 * 估算技能列表的 token 数。
 *
 * @param skills 技能列表
 * @returns 估算 token 数
 */
function _estimateSkillsTokens(skills: ReadonlyArray<SkillDefinitionLike> | undefined): number {
	if (!skills || skills.length === 0) return 0;
	let total = 0;
	for (const skill of skills) total += _jsonTokens(skill);
	return total;
}

/**
 * 估算子代理定义列表的 token 数。
 *
 * @param subagents 子代理定义列表
 * @returns 估算 token 数
 */
function _estimateSubagentsTokens(subagents: ReadonlyArray<SubagentDefinitionLike> | undefined): number {
	if (!subagents || subagents.length === 0) return 0;
	let total = 0;
	for (const sub of subagents) total += _jsonTokens(sub);
	return total;
}

/**
 * 计算上下文使用分解（8 类分类）。
 *
 * 返回 Cursor 风格的上下文使用分布，每类附带 CSS 变量颜色、标识、标签与
 * 估算 token 数。所有估算基于 char/4，不依赖真实 tokenizer。
 *
 * @param agent AgentLike 视图（提供各类上下文来源）
 * @param messages 当前会话消息列表（用于 conversation 分类）
 * @returns 上下文分解结果
 */
export function computeContextBreakdown(
	agent: AgentLike,
	messages: readonly AgentMessage[],
): ContextBreakdown {
	const systemPromptTokens = _textTokens(agent.systemPrompt);
	const toolDefinitionTokens = _estimateToolsTokens(agent.tools);
	const rulesTokens = agent.rules ? _textTokens(agent.rules) : 0;
	const skillsTokens = _estimateSkillsTokens(agent.skills);
	const mcpTokens = _estimateToolsTokens(agent.mcpTools);
	const subagentTokens = _estimateSubagentsTokens(agent.subagents);
	const memoryTokens = _textTokens(agent.memory);
	const conversationTokens = estimateMessagesTokensRough(messages);

	const tokenById: Record<ContextCategoryId, number> = {
		system_prompt: systemPromptTokens,
		tool_definitions: toolDefinitionTokens,
		rules: rulesTokens,
		skills: skillsTokens,
		mcp: mcpTokens,
		subagent_definitions: subagentTokens,
		memory: memoryTokens,
		conversation: conversationTokens,
	};

	const categories: ContextCategory[] = CATEGORY_ORDER.map(({ id, label }) => ({
		id,
		label,
		tokens: tokenById[id],
		color: CATEGORY_COLORS[id],
	}));

	const context_used = categories.reduce((sum, category) => sum + category.tokens, 0);
	const context_max = agent.contextWindow ?? 0;
	const context_percent = context_max > 0 ? Math.min(100, (context_used / context_max) * 100) : 0;

	return {
		categories,
		context_max,
		context_percent,
		context_used,
		estimated_total: context_used,
		model: agent.model ?? "unknown",
	};
}
