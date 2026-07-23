/**
 * learn-prompt 模块单测：验证 AUTHORING_STANDARDS 关键规则与
 * buildLearnPrompt 的拼装行为。
 */
import { describe, expect, test } from "bun:test";
import { AUTHORING_STANDARDS, buildLearnPrompt } from "../src/learn-prompt";

describe("AUTHORING_STANDARDS", () => {
	test("包含 name ≤64 字符规则", () => {
		expect(AUTHORING_STANDARDS).toContain("<= 64 characters");
		expect(AUTHORING_STANDARDS).toMatch(/name.*lowercase-hyphenated/i);
	});

	test("包含 description ≤60 字符 HARD RULE", () => {
		expect(AUTHORING_STANDARDS).toContain("<= 60 characters");
		expect(AUTHORING_STANDARDS).toContain("HARD RULE");
	});

	test("指定 version 为 0.1.0", () => {
		expect(AUTHORING_STANDARDS).toContain('version: "0.1.0"');
	});

	test("指定 author 为 Nexus Agent 且不从环境读取", () => {
		expect(AUTHORING_STANDARDS).toContain('author: "Nexus Agent"');
		expect(AUTHORING_STANDARDS.toLowerCase()).toContain("do not read from environment");
	});

	test("body 章节顺序正确（8 节）", () => {
		const sections = [
			"# Title",
			"## When to Use",
			"## Prerequisites",
			"## How to Run",
			"## Quick Reference",
			"## Procedure",
			"## Pitfalls",
			"## Verification",
		];
		const indices = sections.map(s => AUTHORING_STANDARDS.indexOf(s));
		// 每节都应存在
		for (const idx of indices) {
			expect(idx).toBeGreaterThanOrEqual(0);
		}
		// 顺序应严格递增
		for (let i = 1; i < indices.length; i++) {
			expect(indices[i]).toBeGreaterThan(indices[i - 1]);
		}
	});
});

describe("buildLearnPrompt", () => {
	test("包含用户请求", () => {
		const request = "How to deploy a Bun app to a Linux server";
		const prompt = buildLearnPrompt(request);
		expect(prompt).toContain(request);
		expect(prompt).toContain("THE REQUEST:");
	});

	test("引用 skill_manage 工具且 action 为 create", () => {
		const prompt = buildLearnPrompt("learn something");
		expect(prompt).toContain("skill_manage");
		expect(prompt).toContain('action="create"');
	});

	test("内嵌 AUTHORING_STANDARDS 全文", () => {
		const prompt = buildLearnPrompt("learn something");
		expect(prompt).toContain(AUTHORING_STANDARDS);
	});

	test("以向用户汇报的指令结尾", () => {
		const prompt = buildLearnPrompt("learn something");
		// 去掉末尾空白后应包含 tell the user 行
		const trimmed = prompt.trimEnd();
		expect(trimmed).toMatch(/tell the user the skill name, category, and one-line summary\.$/);
	});

	test("空请求仍可生成 prompt", () => {
		const prompt = buildLearnPrompt("");
		expect(prompt).toContain("THE REQUEST:");
		expect(prompt).toContain(AUTHORING_STANDARDS);
	});

	test("包含来源收集步骤（read/grep/glob/web_fetch）", () => {
		const prompt = buildLearnPrompt("learn something");
		expect(prompt).toContain("read");
		expect(prompt).toContain("grep");
		expect(prompt).toContain("glob");
		expect(prompt).toContain("web_fetch");
	});
});
