/**
 * learning-graph 模块单测：验证 _tokenize、buildSkillNodes、buildEdges、
 * densityStats、buildLearningGraph 的核心行为，包括 memory-skill 边的
 * 词汇重叠打分与技能名 +6 加分。
 */
import { describe, expect, test } from "bun:test";
import {
	buildEdges,
	buildLearningGraph,
	buildMemoryCards,
	buildSkillNodes,
	densityStats,
	_tokenize,
	type GraphNode,
	type MemoryCardInput,
	type SkillRoot,
} from "../src/learning-graph";

describe("_tokenize", () => {
	test("切分为小写 token 并去重", () => {
		const tokens = _tokenize("Deploy Bun app, deploy BUN!");
		expect(tokens).toContain("deploy");
		expect(tokens).toContain("bun");
		expect(tokens).toContain("app");
		// 去重：deploy 只出现一次
		expect(tokens.filter(t => t === "deploy")).toHaveLength(1);
	});

	test("过滤长度 <2 的 token", () => {
		const tokens = _tokenize("a 1 bc de");
		expect(tokens).toContain("bc");
		expect(tokens).toContain("de");
		expect(tokens).not.toContain("a");
		expect(tokens).not.toContain("1");
	});

	test("空字符串返回空数组", () => {
		expect(_tokenize("")).toEqual([]);
	});

	test("无字母数字时返回空数组", () => {
		expect(_tokenize("!!! ... ???")).toEqual([]);
	});
});

describe("buildSkillNodes", () => {
	const roots: SkillRoot[] = [
		{ name: "deploy-app", description: "deploy a bun app", filePath: "/a/SKILL.md", source: "native:user" },
		{ name: "read-file", description: "read a file safely", filePath: "/b/SKILL.md", source: "native:user" },
	];

	test("构建节点并按 name 字母序排序", () => {
		const nodes = buildSkillNodes(roots);
		expect(nodes).toHaveLength(2);
		expect(nodes[0].name).toBe("deploy-app");
		expect(nodes[1].name).toBe("read-file");
		expect(nodes[0].type).toBe("skill");
		expect(nodes[0].id).toBe("deploy-app");
	});

	test("tokens 为 char/4 估算", () => {
		const nodes = buildSkillNodes([roots[0]]);
		const text = `${roots[0].name} ${roots[0].description}`;
		const expected = Math.floor((text.length + 3) / 4);
		expect(nodes[0].tokens).toBe(expected);
	});

	test("跳过无名与重名技能", () => {
		const dupRoots: SkillRoot[] = [
			{ name: "dup", description: "first", filePath: "/x", source: "a" },
			{ name: "dup", description: "second", filePath: "/y", source: "b" },
			{ name: "", description: "no name", filePath: "/z", source: "c" },
		];
		const nodes = buildSkillNodes(dupRoots);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].description).toBe("first");
	});

	test("空列表返回空数组", () => {
		expect(buildSkillNodes([])).toEqual([]);
	});
});

describe("buildMemoryCards", () => {
	const inputs: MemoryCardInput[] = [
		{ id: "m1", content: "user prefers bun", bank: "project" },
		{ id: "m2", content: "deploy steps here", source: "coding-agent-transcript" },
	];

	test("构建记忆卡片节点", () => {
		const cards = buildMemoryCards(inputs);
		expect(cards).toHaveLength(2);
		expect(cards[0].type).toBe("memory");
		expect(cards[0].id).toBe("m1");
		expect(cards[0].bank).toBe("project");
		expect(cards[1].source).toBe("coding-agent-transcript");
	});

	test("跳过无 id 与重复 id", () => {
		const dupInputs: MemoryCardInput[] = [
			{ id: "m1", content: "first" },
			{ id: "m1", content: "second" },
			{ id: "", content: "no id" },
		];
		const cards = buildMemoryCards(dupInputs);
		expect(cards).toHaveLength(1);
		expect(cards[0].content).toBe("first");
	});

	test("缺省字段回退为 null/空字符串", () => {
		const cards = buildMemoryCards([{ id: "m1", content: "x" }]);
		expect(cards[0].source).toBeNull();
		expect(cards[0].timestamp).toBeNull();
		expect(cards[0].importance).toBeNull();
		expect(cards[0].bank).toBe("");
	});
});

describe("buildEdges", () => {
	test("skill-skill 边：词汇重叠 > 0 时连边", () => {
		const nodes: GraphNode[] = [
			{ id: "deploy", type: "skill", name: "deploy", description: "deploy bun app", filePath: "/a", source: "s", tokens: 1 },
			{ id: "build", type: "skill", name: "build", description: "build bun app", filePath: "/b", source: "s", tokens: 1 },
		];
		const edges = buildEdges(nodes);
		const ssEdge = edges.find(e => e.kind === "skill-skill");
		expect(ssEdge).toBeDefined();
		// deploy 与 build 共享 "bun" 与 "app" token
		expect(ssEdge?.weight).toBeGreaterThanOrEqual(2);
		// 方向：source < target（按数组顺序 i<j）
		expect(ssEdge?.source).toBe("deploy");
		expect(ssEdge?.target).toBe("build");
	});

	test("skill-skill 边：无重叠时不连边", () => {
		const nodes: GraphNode[] = [
			{ id: "alpha", type: "skill", name: "alpha", description: "xyz", filePath: "/a", source: "s", tokens: 1 },
			{ id: "beta", type: "skill", name: "beta", description: "qrs", filePath: "/b", source: "s", tokens: 1 },
		];
		const edges = buildEdges(nodes);
		expect(edges.filter(e => e.kind === "skill-skill")).toHaveLength(0);
	});

	test("memory-skill 边：词汇重叠 + 技能名 +6", () => {
		const nodes: GraphNode[] = [
			{ id: "deploy", type: "skill", name: "deploy", description: "deploy app", filePath: "/a", source: "s", tokens: 1 },
			{
				id: "mem1",
				type: "memory",
				content: "how to deploy the app",
				source: null,
				timestamp: null,
				importance: null,
				bank: "b",
				tokens: 1,
			},
		];
		const edges = buildEdges(nodes);
		const msEdge = edges.find(e => e.kind === "memory-skill");
		expect(msEdge).toBeDefined();
		// "deploy" 与 "app" 两个 token 重叠 → overlap=2；技能名 "deploy" 出现在内容中 → +6
		expect(msEdge?.weight).toBe(8);
		expect(msEdge?.source).toBe("mem1");
		expect(msEdge?.target).toBe("deploy");
	});

	test("memory-skill 边：技能名命中包含 +6 加分", () => {
		const nodes: GraphNode[] = [
			{ id: "deploy", type: "skill", name: "deploy", description: "zzz", filePath: "/a", source: "s", tokens: 1 },
			{
				id: "mem1",
				type: "memory",
				content: "deploy",
				source: null,
				timestamp: null,
				importance: null,
				bank: "b",
				tokens: 1,
			},
		];
		const edges = buildEdges(nodes);
		const msEdge = edges.find(e => e.kind === "memory-skill");
		expect(msEdge).toBeDefined();
		// 技能 tokens: ["deploy", "zzz"]；记忆 tokens: ["deploy"] → overlap=1
		// 技能名 "deploy" 出现在内容 "deploy" 中 → +6
		// total = 1 + 6 = 7
		expect(msEdge?.weight).toBe(7);
	});

	test("memory-skill 边：无重叠且无技能名命中时不连边", () => {
		const nodes: GraphNode[] = [
			{ id: "alpha", type: "skill", name: "alpha", description: "xyz", filePath: "/a", source: "s", tokens: 1 },
			{
				id: "mem1",
				type: "memory",
				content: "completely unrelated content",
				source: null,
				timestamp: null,
				importance: null,
				bank: "b",
				tokens: 1,
			},
		];
		const edges = buildEdges(nodes);
		expect(edges.filter(e => e.kind === "memory-skill")).toHaveLength(0);
	});

	test("自环不连", () => {
		const nodes: GraphNode[] = [
			{ id: "solo", type: "skill", name: "solo", description: "solo", filePath: "/a", source: "s", tokens: 1 },
		];
		const edges = buildEdges(nodes);
		expect(edges).toHaveLength(0);
	});

	test("空节点列表返回空边列表", () => {
		expect(buildEdges([])).toEqual([]);
	});
});

describe("densityStats", () => {
	test("空图统计为 0", () => {
		const stats = densityStats([], []);
		expect(stats.nodeCount).toBe(0);
		expect(stats.edgeCount).toBe(0);
		expect(stats.density).toBe(0);
		expect(stats.averageDegree).toBe(0);
	});

	test("单节点密度为 0（N=1）", () => {
		const nodes: GraphNode[] = [
			{ id: "solo", type: "skill", name: "solo", description: "x", filePath: "/a", source: "s", tokens: 1 },
		];
		const stats = densityStats(nodes, []);
		expect(stats.nodeCount).toBe(1);
		expect(stats.density).toBe(0);
		expect(stats.skillCount).toBe(1);
		expect(stats.memoryCount).toBe(0);
	});

	test("完整图密度计算正确", () => {
		const nodes: GraphNode[] = [
			{ id: "a", type: "skill", name: "a", description: "shared", filePath: "/a", source: "s", tokens: 1 },
			{ id: "b", type: "skill", name: "b", description: "shared", filePath: "/b", source: "s", tokens: 1 },
			{ id: "c", type: "skill", name: "c", description: "shared", filePath: "/c", source: "s", tokens: 1 },
		];
		// 完全图 K3 有 3 条边；密度 = 2*3 / (3*2) = 1
		const edges = [
			{ source: "a", target: "b", weight: 1, kind: "skill-skill" as const },
			{ source: "a", target: "c", weight: 1, kind: "skill-skill" as const },
			{ source: "b", target: "c", weight: 1, kind: "skill-skill" as const },
		];
		const stats = densityStats(nodes, edges);
		expect(stats.edgeCount).toBe(3);
		expect(stats.density).toBeCloseTo(1, 5);
		expect(stats.averageDegree).toBeCloseTo(2, 5);
	});
});

describe("buildLearningGraph", () => {
	test("组合技能与记忆构建完整图谱", () => {
		const skills: SkillRoot[] = [
			{ name: "deploy", description: "deploy bun app", filePath: "/a", source: "s" },
			{ name: "build", description: "build bun app", filePath: "/b", source: "s" },
		];
		const memories: MemoryCardInput[] = [
			{ id: "m1", content: "deploy the bun app to prod" },
		];
		const graph = buildLearningGraph({ skills, memories });
		expect(graph.nodes).toHaveLength(3);
		expect(graph.stats.skillCount).toBe(2);
		expect(graph.stats.memoryCount).toBe(1);
		// deploy↔build（共享 bun/app）+ m1→deploy + m1→build
		expect(graph.edges.length).toBeGreaterThanOrEqual(3);
		expect(graph.stats.edgeCount).toBe(graph.edges.length);
	});

	test("无记忆时仅构建技能子图", () => {
		const skills: SkillRoot[] = [
			{ name: "alpha", description: "xyz", filePath: "/a", source: "s" },
			{ name: "beta", description: "qrs", filePath: "/b", source: "s" },
		];
		const graph = buildLearningGraph({ skills });
		expect(graph.nodes).toHaveLength(2);
		expect(graph.stats.memoryCount).toBe(0);
		// alpha/xyz 与 beta/qrs 无共享 token → 无 skill-skill 边
		expect(graph.edges).toHaveLength(0);
	});

	test("空输入返回空图", () => {
		const graph = buildLearningGraph({ skills: [] });
		expect(graph.nodes).toEqual([]);
		expect(graph.edges).toEqual([]);
		expect(graph.stats.nodeCount).toBe(0);
	});
});
