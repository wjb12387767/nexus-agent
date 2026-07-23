/**
 * 将 hermes 风格的 8 类上下文分解（来自 `@oh-my-pi/pi-agent-core/context-breakdown`）
 * 适配到 coding-agent 的 AgentSession，并渲染为 `/context` 可追加的文本块。
 *
 * 当 `context.breakdown` 设置开启时，由 `context-report.ts` 追加到现有上下文
 * 报告之后，提供 Cursor 风格的 8 类分类视图。
 */
import { computeContextBreakdown, type AgentLike } from "@oh-my-pi/pi-agent-core/context-breakdown";
import type { SettingPath, SettingValue } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type { Skill } from "../../extensibility/skills";
import { renderAsciiBar } from "./format";

/** `/context` 报告中 hermes 8 类分解的标题。 */
const HERMES_BREAKDOWN_HEADING = "Context Breakdown (8 categories)";

/**
 * 从 AgentSession 构建最小 AgentLike 视图。
 *
 * 仅提取 readily available 的字段（model、contextWindow、systemPrompt、tools、
 * skills、messages）；rules/mcp/subagents/memory 在会话对象上没有单一访问点时
 * 留空（对应分类记为 0 token）。
 */
function buildAgentLike(session: AgentSession): AgentLike {
	const model = session.model;
	const tools = session.agent?.state?.tools;
	const toolList = tools ? [...tools.values()].map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	})) : undefined;
	const skills: readonly Skill[] | undefined = session.skills ?? undefined;
	const skillList = skills?.map(skill => ({
		name: skill.name,
		description: skill.description,
	}));

	return {
		model: model ? `${model.provider}/${model.id}` : undefined,
		contextWindow: model?.contextWindow ?? undefined,
		systemPrompt: session.systemPrompt,
		tools: toolList,
		skills: skillList,
	};
}

/**
 * 渲染 hermes 8 类上下文分解为文本块。
 *
 * 每类一行：标签 + ASCII 条 + token 数 + 百分比。仅展示 token 数 > 0 的分类。
 *
 * @param session 当前 AgentSession
 * @returns 文本块；当 `context.breakdown` 关闭或无模型时返回空字符串
 */
export function buildHermesBreakdownText(session: AgentSession): string {
	const enabled = session.settings.get("context.breakdown" as SettingPath) as SettingValue<
		"context.breakdown"
	>;
	if (enabled === false) return "";

	const agent = buildAgentLike(session);
	const messages = session.messages ?? [];
	const breakdown = computeContextBreakdown(agent, messages);

	if (breakdown.context_max <= 0) return "";

	const lines = ["", HERMES_BREAKDOWN_HEADING];
	for (const category of breakdown.categories) {
		if (category.tokens === 0) continue;
		const fraction = breakdown.context_max > 0 ? category.tokens / breakdown.context_max : 0;
		const pct = breakdown.context_max > 0 ? `${(fraction * 100).toFixed(1)}%` : "—";
		lines.push(`  ${category.label.padEnd(22)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens (${pct})`);
	}
	lines.push(
		`  ${"Total".padEnd(22)} ${renderAsciiBar(breakdown.context_used / breakdown.context_max)}  ${breakdown.context_used} tokens (${breakdown.context_percent.toFixed(1)}%)`,
	);
	return lines.join("\n");
}
