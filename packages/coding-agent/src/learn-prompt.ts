/**
 * /learn 命令的 prompt 构建模块（A3 标准化技能学习引导）。
 *
 * 移植自 hermes-agent 的 `/learn` 能力。该模块是一个纯函数模块，不直接执行
 * 技能创建——它生成一段引导 prompt，驱动模型使用现有的 `learn` / `manage_skill`
 * 工具完成技能编写与保存。
 *
 * `AUTHORING_STANDARDS` 定义了技能编写标准（name/description/version/author 与
 * body 章节顺序），`buildLearnPrompt(userRequest)` 将用户请求与标准拼接为完整
 * prompt。
 */

/**
 * 技能编写标准（AUTHORING_STANDARDS）。
 *
 * 参考 hermes 的 `_AUTHORING_STANDARDS`，定义 SKILL.md 的 frontmatter 与 body
 * 规范。模型在生成技能时应严格遵循这些规则。
 */
export const AUTHORING_STANDARDS = `SKILL AUTHORING STANDARDS (follow exactly):

Frontmatter (YAML between --- fences):
- name: lowercase-hyphenated, only [a-z0-9-], <= 64 characters, must start with a letter or digit.
- description: <= 60 characters (HARD RULE). One line describing when to use the skill.
- version: "0.1.0"
- author: "Nexus Agent" (do NOT read from environment)

Body section order (use exactly these headings in this order):
1. # Title            — human-readable title (not the name)
2. ## When to Use     — triggers and scenarios where this skill applies
3. ## Prerequisites   — required tools, access, or prior steps
4. ## How to Run      — invocation entry point and parameters
5. ## Quick Reference — condensed cheat-sheet of key facts/commands
6. ## Procedure       — numbered step-by-step instructions
7. ## Pitfalls        — common mistakes and how to avoid them
8. ## Verification    — how to confirm the skill worked correctly

Rules:
- Body is markdown only (no frontmatter in the body field).
- Keep the body self-contained and reusable across sessions.
- Do not include secrets or environment-specific paths.`;

/**
 * 构建 /learn 命令的完整 prompt。
 *
 * 将用户请求与编写标准拼接为一段引导 prompt，驱动模型：收集来源 → 编写一个
 * SKILL.md → 通过 skill_manage 工具保存 → 向用户汇报技能名称、分类与摘要。
 *
 * @param userRequest 用户的原始学习请求
 * @returns 完整的引导 prompt 字符串
 */
export function buildLearnPrompt(userRequest: string): string {
	return `The user wants you to learn a reusable skill from the request below, and save it.
THE REQUEST: ${userRequest}
Do this:
1. Gather sources (read/grep/glob/web_fetch)
2. Author ONE SKILL.md and save with skill_manage tool (action="create")
${AUTHORING_STANDARDS}
When done, tell the user the skill name, category, and one-line summary.`;
}
