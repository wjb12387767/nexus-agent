/**
 * 技能学习图谱（A4 Learning Graph）。
 *
 * 移植自 hermes-agent 的 learning_graph 能力。该模块是纯函数模块，输入技能
 * 列表与记忆卡片列表，输出一张二部图（skill-skill 与 memory-skill 边），
 * 用于 /skills-graph 命令的可视化。
 *
 * - SkillNode：技能节点（来自已加载的 Skill 列表）
 * - MemoryCard：记忆卡片节点（来自 mnemopi 的 recall 结果）
 * - 边权重基于词汇重叠（tokenize intersection）；memory-skill 边在技能名出现
 *   在记忆内容中时额外 +6。
 *
 * 估算沿用 char/4 估算（与 context-breakdown 保持一致），不依赖真实 tokenizer。
 */

/** 技能节点。 */
export interface SkillNode {
	/** 节点 id（即技能名，作为唯一键）。 */
	id: string;
	/** 节点类型标识。 */
	type: "skill";
	/** 技能名。 */
	name: string;
	/** 技能描述。 */
	description: string;
	/** 技能文件绝对路径。 */
	filePath: string;
	/** 技能来源（provider:level）。 */
	source: string;
	/** name+description 的近似 token 数（char/4 估算）。 */
	tokens: number;
}

/** 记忆卡片节点。 */
export interface MemoryCard {
	/** 节点 id（即记忆 id，作为唯一键）。 */
	id: string;
	/** 节点类型标识。 */
	type: "memory";
	/** 记忆内容。 */
	content: string;
	/** 记忆来源标签。 */
	source: string | null;
	/** 记忆时间戳。 */
	timestamp: string | null;
	/** 记忆重要度。 */
	importance: number | null;
	/** 记忆所属 bank。 */
	bank: string;
	/** content 的近似 token 数（char/4 估算）。 */
	tokens: number;
}

/** 图节点（技能或记忆）。 */
export type GraphNode = SkillNode | MemoryCard;

/** 边类型。 */
export type EdgeKind = "skill-skill" | "memory-skill";

/** 图的边。 */
export interface GraphEdge {
	/** 起点节点 id。 */
	source: string;
	/** 终点节点 id。 */
	target: string;
	/** 词汇重叠分数（memory-skill 边可能包含 +6 加分）。 */
	weight: number;
	/** 边类型。 */
	kind: EdgeKind;
}

/** 图的密度统计。 */
export interface DensityStats {
	/** 节点总数。 */
	nodeCount: number;
	/** 边总数。 */
	edgeCount: number;
	/** 技能节点数。 */
	skillCount: number;
	/** 记忆节点数。 */
	memoryCount: number;
	/** 平均度数（2E/N）。 */
	averageDegree: number;
	/** 无向图密度 2E / (N*(N-1))，N≤1 时为 0。 */
	density: number;
}

/** 学习图谱。 */
export interface LearningGraph {
	/** 所有节点（技能 + 记忆）。 */
	nodes: GraphNode[];
	/** 所有边。 */
	edges: GraphEdge[];
	/** 密度统计。 */
	stats: DensityStats;
}

/**
 * 技能根（最小视图，解耦自 Skill 的完整字段）。
 *
 * 调用方从 `runtime.session.skills` 提取该形状后传入
 * {@link buildLearningGraph}，避免核心模块依赖 coding-agent 的 Skill 类型。
 */
export interface SkillRoot {
	/** 技能名。 */
	name: string;
	/** 技能描述。 */
	description: string;
	/** 技能文件绝对路径。 */
	filePath: string;
	/** 技能来源（provider:level）。 */
	source: string;
}

/** 记忆卡片输入（最小视图，由调用方从 recall 结果填充）。 */
export interface MemoryCardInput {
	/** 记忆 id。 */
	id: string;
	/** 记忆内容。 */
	content: string;
	/** 记忆来源标签。 */
	source?: string | null;
	/** 记忆时间戳。 */
	timestamp?: string | null;
	/** 记忆重要度。 */
	importance?: number | null;
	/** 记忆所属 bank。 */
	bank?: string;
}

/** buildLearningGraph 的输入。 */
export interface LearningGraphInput {
	/** 技能根列表。 */
	skills: readonly SkillRoot[];
	/** 可选的记忆卡片列表；缺省时仅构建技能子图。 */
	memories?: readonly MemoryCardInput[];
}

/** 技能名出现在记忆内容中的额外加分（与 hermes 一致）。 */
const SKILL_NAME_BONUS = 6;

/** char/4 token 估算（与 context-breakdown 保持一致）。 */
function _charsToTokens(text: string): number {
	return Math.floor((text.length + 3) / 4);
}

/**
 * 将文本切分为小写 token 集合（用于词汇重叠打分）。
 *
 * 仅保留长度 ≥ 2 的字母数字 token，去重。这与 hermes 的 _tokenize 行为一致：
 * 轻量、无外部依赖、对大小写不敏感。返回数组便于调用方按需再转 Set。
 *
 * @param text 原始文本
 * @returns 去重后的小写 token 数组
 */
export function _tokenize(text: string): string[] {
	const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const filtered = matches.filter(token => token.length >= 2);
	return [...new Set(filtered)];
}

/**
 * 从已加载的技能列表构建技能节点。
 *
 * 跳过无名或重名的技能；结果按 name 字母序排序，便于稳定输出与测试。
 *
 * @param skillRoots 技能根列表（name/description/filePath/source）
 * @returns SkillNode[]
 */
export function buildSkillNodes(skillRoots: readonly SkillRoot[]): SkillNode[] {
	const seen = new Set<string>();
	const nodes: SkillNode[] = [];
	for (const root of skillRoots) {
		if (!root.name) continue;
		if (seen.has(root.name)) continue;
		seen.add(root.name);
		const text = `${root.name} ${root.description}`;
		nodes.push({
			id: root.name,
			type: "skill",
			name: root.name,
			description: root.description,
			filePath: root.filePath,
			source: root.source,
			tokens: _charsToTokens(text),
		});
	}
	nodes.sort((a, b) => a.name.localeCompare(b.name));
	return nodes;
}

/**
 * 从记忆卡片输入列表构建记忆节点。
 *
 * 跳过无 id 或重复 id 的记忆。
 *
 * @param memories 记忆卡片输入列表
 * @returns MemoryCard[]
 */
export function buildMemoryCards(memories: readonly MemoryCardInput[]): MemoryCard[] {
	const seen = new Set<string>();
	const cards: MemoryCard[] = [];
	for (const mem of memories) {
		if (!mem.id) continue;
		if (seen.has(mem.id)) continue;
		seen.add(mem.id);
		cards.push({
			id: mem.id,
			type: "memory",
			content: mem.content,
			source: mem.source ?? null,
			timestamp: mem.timestamp ?? null,
			importance: mem.importance ?? null,
			bank: mem.bank ?? "",
			tokens: _charsToTokens(mem.content),
		});
	}
	return cards;
}

/**
 * 计算两个 token 数组的交集大小（保留重复计数：以 b 中每个 token 是否在 a 中
 * 出现为标准）。两个数组都应为去重后的 token 列表（来自 _tokenize）。
 */
function _intersectionSize(a: readonly string[], b: readonly string[]): number {
	const setA = new Set(a);
	let count = 0;
	for (const token of b) {
		if (setA.has(token)) count++;
	}
	return count;
}

/**
 * 根据节点列表构建图边。
 *
 * - skill-skill 边：两个技能的 name+description token 交集 > 0 时连边，
 *   权重 = 交集大小。
 * - memory-skill 边：记忆 content token 与技能 name+description token 交集 > 0，
 *   或技能名（长度 ≥ 2）出现在记忆内容中时连边。
 *   权重 = 交集大小 +（技能名出现 ? {@link SKILL_NAME_BONUS} : 0）。
 *
 * 自环不连；skill-skill 同对节点只连一次（i < j）；memory-skill 方向为
 * memory → skill。
 *
 * @param nodes 图节点列表（技能 + 记忆）
 * @returns GraphEdge[]
 */
export function buildEdges(nodes: readonly GraphNode[]): GraphEdge[] {
	const skills = nodes.filter((n): n is SkillNode => n.type === "skill");
	const memories = nodes.filter((n): n is MemoryCard => n.type === "memory");
	const edges: GraphEdge[] = [];

	// 缓存每个技能的 token 集合（name + description）
	const skillTokens = new Map<string, string[]>();
	for (const skill of skills) {
		skillTokens.set(skill.id, _tokenize(`${skill.name} ${skill.description}`));
	}

	// skill-skill 边：两两组合
	for (let i = 0; i < skills.length; i++) {
		const a = skills[i];
		const tokensA = skillTokens.get(a.id) ?? [];
		for (let j = i + 1; j < skills.length; j++) {
			const b = skills[j];
			const tokensB = skillTokens.get(b.id) ?? [];
			const overlap = _intersectionSize(tokensA, tokensB);
			if (overlap > 0) {
				edges.push({
					source: a.id,
					target: b.id,
					weight: overlap,
					kind: "skill-skill",
				});
			}
		}
	}

	// memory-skill 边：词汇重叠 + 技能名命中加分
	for (const mem of memories) {
		const memTokens = _tokenize(mem.content);
		const memLower = mem.content.toLowerCase();
		for (const skill of skills) {
			const skillTokensList = skillTokens.get(skill.id) ?? [];
			const overlap = _intersectionSize(memTokens, skillTokensList);
			const nameHit = skill.name.length >= 2 && memLower.includes(skill.name.toLowerCase());
			const weight = overlap + (nameHit ? SKILL_NAME_BONUS : 0);
			if (weight > 0) {
				edges.push({
					source: mem.id,
					target: skill.id,
					weight,
					kind: "memory-skill",
				});
			}
		}
	}

	return edges;
}

/**
 * 计算图的密度统计。
 *
 * @param nodes 图节点列表
 * @param edges 图边列表
 * @returns DensityStats（nodeCount/edgeCount/skillCount/memoryCount/averageDegree/density）
 */
export function densityStats(
	nodes: readonly GraphNode[],
	edges: readonly GraphEdge[],
): DensityStats {
	const nodeCount = nodes.length;
	const edgeCount = edges.length;
	const skillCount = nodes.filter(n => n.type === "skill").length;
	const memoryCount = nodes.filter(n => n.type === "memory").length;
	const averageDegree = nodeCount > 0 ? (2 * edgeCount) / nodeCount : 0;
	const density = nodeCount > 1 ? (2 * edgeCount) / (nodeCount * (nodeCount - 1)) : 0;
	return {
		nodeCount,
		edgeCount,
		skillCount,
		memoryCount,
		averageDegree,
		density,
	};
}

/**
 * 构建完整的学习图谱。
 *
 * 组合 {@link buildSkillNodes}、{@link buildMemoryCards}、{@link buildEdges} 与
 * {@link densityStats}，一次性产出 nodes + edges + stats。
 *
 * @param input 技能列表与可选记忆卡片列表
 * @returns LearningGraph
 */
export function buildLearningGraph(input: LearningGraphInput): LearningGraph {
	const skillNodes = buildSkillNodes(input.skills);
	const memoryCards = buildMemoryCards(input.memories ?? []);
	const nodes: GraphNode[] = [...skillNodes, ...memoryCards];
	const edges = buildEdges(nodes);
	const stats = densityStats(nodes, edges);
	return { nodes, edges, stats };
}
