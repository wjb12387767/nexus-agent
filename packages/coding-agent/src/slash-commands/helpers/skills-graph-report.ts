/**
 * 将学习图谱（来自 `../../learning-graph`）适配到 coding-agent 的 AgentSession，
 * 并渲染为 `/skills-graph` 的文本输出。
 *
 * 当 `skills.learningGraph` 设置开启时，从 `runtime.session.skills` 与 mnemopi
 * 记忆库（可选）构建图谱，按节点 + 边 + 密度统计的顺序渲染。
 */
import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import {
	buildLearningGraph,
	type LearningGraph,
	type MemoryCardInput,
	type SkillRoot,
} from "../../learning-graph";
import { getMnemopiSessionState } from "../../mnemopi/state";
import type { SettingPath, SettingValue } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import type { Settings } from "../../config/settings";

/**
 * /skills-graph 文本构建所需的最小运行时视图。
 *
 * `SlashCommandRuntime`（ACP）与 `{ session, settings }`（从 TUI 的
 * `runtime.ctx` 提取）均结构满足该接口，避免核心 helper 绑定到特定运行时。
 */
export interface SkillsGraphRuntime {
	/** 当前 AgentSession。 */
	session: AgentSession;
	/** 设置存储。 */
	settings: Settings;
}

/** /skills-graph 报告标题。 */
const SKILLS_GRAPH_HEADING = "Skills Learning Graph";

/**
 * 从 AgentSession 提取技能根列表。
 *
 * 仅取 name/description/filePath/source 四个字段，匹配 SkillRoot 形状。
 */
function extractSkillRoots(session: AgentSession): SkillRoot[] {
	return session.skills.map(skill => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		source: skill.source,
	}));
}

/**
 * 尝试从 mnemopi 会话状态收集记忆卡片。
 *
 * 使用 "skill" 作为 recall 查询以尽量召回与技能相关的记忆；任何失败（无
 * mnemopi 状态、recall 抛错、空 id）都降级为空列表，图谱退化为技能子图。
 */
async function collectMemoryCards(session: AgentSession): Promise<MemoryCardInput[]> {
	const state = getMnemopiSessionState(session);
	if (!state) return [];
	try {
		const results: RecallResult[] = await state.collectScopedRecallResults("skill");
		const bank = state.getScopedRetainTarget().bank;
		const cards: MemoryCardInput[] = [];
		for (const result of results) {
			const id = result.id ?? "";
			if (!id) continue;
			cards.push({
				id,
				content: result.content,
				source: result.source,
				timestamp: result.timestamp,
				importance: result.importance,
				bank,
			});
		}
		return cards;
	} catch {
		return [];
	}
}

/**
 * 渲染单个节点行。
 *
 * 技能节点显示 name + token 数；记忆节点显示截断 content + token 数。
 */
function renderNodeLine(node: LearningGraph["nodes"][number]): string {
	if (node.type === "skill") {
		return `  [skill] ${node.name}  (${node.tokens} tok, src=${node.source || "—"})`;
	}
	const preview = node.content.replace(/\s+/g, " ").trim();
	const clipped = preview.length > 60 ? `${preview.slice(0, 59)}…` : preview || "(empty)";
	return `  [memory] ${node.id}  (${node.tokens} tok, bank=${node.bank || "—"}) ${clipped}`;
}

/**
 * 渲染单条边。
 *
 * skill-skill 边显示双向；memory-skill 边显示 memory → skill 方向。
 */
function renderEdgeLine(edge: LearningGraph["edges"][number]): string {
	const arrow = edge.kind === "memory-skill" ? "→" : "↔";
	return `  ${edge.source} ${arrow} ${edge.target}  (w=${edge.weight}, ${edge.kind})`;
}

/**
 * 渲染整张学习图谱为文本。
 */
function renderLearningGraph(graph: LearningGraph): string {
	const lines: string[] = [SKILLS_GRAPH_HEADING];
	const { stats } = graph;
	lines.push(
		`Nodes: ${stats.nodeCount} (skills=${stats.skillCount}, memories=${stats.memoryCount})`,
	);
	lines.push(`Edges: ${stats.edgeCount}`);
	lines.push(
		`Density: ${stats.density.toFixed(3)}  Avg degree: ${stats.averageDegree.toFixed(2)}`,
	);

	if (graph.nodes.length > 0) {
		lines.push("", "Nodes:");
		for (const node of graph.nodes) lines.push(renderNodeLine(node));
	}
	if (graph.edges.length > 0) {
		lines.push("", "Edges:");
		// 按权重降序展示，便于一眼看到强关联
		const sorted = [...graph.edges].sort((a, b) => b.weight - a.weight);
		for (const edge of sorted) lines.push(renderEdgeLine(edge));
	}
	return lines.join("\n");
}

/**
 * 构建 /skills-graph 命令的文本输出。
 *
 * 当 `skills.learningGraph` 关闭时返回提示文本；否则从会话技能与记忆库构建
 * 图谱并渲染。接受最小运行时视图，ACP 与 TUI 调用方均可满足。
 *
 * @param runtime 包含 session 与 settings 的最小运行时视图
 * @returns 渲染后的文本
 */
export async function buildSkillsGraphText(runtime: SkillsGraphRuntime): Promise<string> {
	const enabled = runtime.settings.get("skills.learningGraph" as SettingPath) as SettingValue<
		"skills.learningGraph"
	>;
	if (enabled === false) {
		return "Skills learning graph is disabled. Enable it in /settings (tools → Skills → Learning Graph).";
	}

	const skills = extractSkillRoots(runtime.session);
	if (skills.length === 0) {
		return "No skills loaded. Nothing to graph.";
	}

	const memories = await collectMemoryCards(runtime.session);
	const graph = buildLearningGraph({ skills, memories });
	return renderLearningGraph(graph);
}
