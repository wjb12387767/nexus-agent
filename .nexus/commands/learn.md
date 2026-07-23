# Learn Command

Learn a reusable skill from the request below and save it as a managed SKILL.md.

## Arguments

- `$ARGUMENTS`: The user's request describing what skill to learn.

## Instructions

Use the `buildLearnPrompt(userRequest)` flow from `packages/coding-agent/src/learn-prompt.ts` to drive this task. The effective prompt is:

```
The user wants you to learn a reusable skill from the request below, and save it.
THE REQUEST: $ARGUMENTS
Do this:
1. Gather sources (read/grep/glob/web_fetch)
2. Author ONE SKILL.md and save with skill_manage tool (action="create")
<AUTHORING_STANDARDS>
When done, tell the user the skill name, category, and one-line summary.
```

### Authoring Standards

Frontmatter (YAML between `---` fences):

- `name`: lowercase-hyphenated, only `[a-z0-9-]`, ≤ 64 characters, must start with a letter or digit.
- `description`: ≤ 60 characters (HARD RULE). One line describing when to use the skill.
- `version`: `"0.1.0"`
- `author`: `"Nexus Agent"` (do NOT read from environment)

Body section order (use exactly these headings in this order):

1. `# Title` — human-readable title (not the name)
2. `## When to Use` — triggers and scenarios where this skill applies
3. `## Prerequisites` — required tools, access, or prior steps
4. `## How to Run` — invocation entry point and parameters
5. `## Quick Reference` — condensed cheat-sheet of key facts/commands
6. `## Procedure` — numbered step-by-step instructions
7. `## Pitfalls` — common mistakes and how to avoid them
8. `## Verification` — how to confirm the skill worked correctly

### Execution Steps

1. Parse `$ARGUMENTS` as the skill-learning request.
2. Gather sources: use `read`, `grep`, `glob`, and `web_fetch` to collect the knowledge needed.
3. Author exactly ONE `SKILL.md` following the authoring standards above.
4. Save it with the `manage_skill` tool (`action="create"`), passing `name`, `description`, and `body`.
5. When done, tell the user the skill name, its category, and a one-line summary.

### Notes

- This command is the user-facing entry point; it guides the model to use the existing `learn` / `manage_skill` tools.
- If `manage_skill` reports a name collision with an authored skill, pick a different name and retry.
- Do not include secrets or environment-specific paths in the skill body.
