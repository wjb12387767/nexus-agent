/**
 * Nexus Compaction —— Prompt 模板。
 *
 * 模板结构对齐 Grok `xai-grok-compaction`：
 * - 历史摘要 prompt（`templates/compaction_user_prompt.txt`）：7 段式结构化摘要。
 * - step 摘要 prompt（`steps/prompt.rs`）：当前 loop 累计 step 的精简摘要。
 * - code-compaction 摘要 prompt（`code_compaction/prompt.rs`）：代码块专用。
 *
 * Nexus 在保留算法核心的前提下做了适度精简，使模板自包含、可读。
 */

import type { CompactionPrompt } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// 历史摘要 prompt（对应 Grok `compaction_user_prompt.txt`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 历史摘要的 developer / user prompt。
 * Grok 让两者完全相同，便于模型在两轮都看到指令 —— 这里保持一致。
 */
export const HISTORY_COMPACTION_PROMPT_BODY = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and all previous actions.

This summary should be thorough in capturing technical details, code patterns, architectural decisions, tool chains, and verification steps that would be essential for continuing development without losing context.

Use your internal thinking channel to chronologically analyze each message before producing the final summary. Thoroughly identify:
- the user's explicit requests and evolving intents
- the agent's approach: reasoning steps, specific tool calls, parameters, results
- key decisions, technical concepts, code patterns, and architectural choices
- specific details like file names, full code snippets (especially recent ones), function signatures, file edits / diffs, tool call details
- errors encountered and how they were diagnosed / fixed
- specific user feedback, especially corrections or direction changes

Your final summary must contain the following sections, in order:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents, including any evolution over the conversation.

2. Key Technical Concepts: List all important technical concepts, technologies, frameworks, and tool patterns discussed.

3. Tool Usage & Verification: Summarize significant tool calls, key information retrieved / verified, and how they influenced decisions.

4. Files and Code Sections: Enumerate all specific files, code sections, or executions examined, modified, or created. Include full code snippets where applicable, plus a summary of why each artifact is important for continuation.

5. Errors and Fixes: List all errors encountered, how you fixed them, and specific user feedback.

6. Problem Solving: Document problems solved, tool-assisted solutions, and any ongoing troubleshooting efforts.

7. All User Messages: List ALL user messages that are not tool results (verbatim or high-fidelity summary). These are critical for understanding feedback and intent changes.

Output the summary directly using the section headings above. Do not wrap the output in any XML tags or other markup — emit the seven sections as plain text.`;

/** 构造历史摘要 prompt 对。对应 Grok `format_compaction_developer_prompt` + `format_compaction_user_prompt`。 */
export function buildHistoryCompactionPrompt(): CompactionPrompt {
  return { system: HISTORY_COMPACTION_PROMPT_BODY, user: HISTORY_COMPACTION_PROMPT_BODY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 摘要 prompt（对应 Grok `steps/prompt.rs`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 当前 loop 累计 step 的精简摘要 prompt。
 * Step 摘要比历史摘要更聚焦：只关心当前任务的进度与下一步。
 */
export const STEP_COMPACTION_PROMPT_BODY = `Summarize the accumulated steps of the current agent loop so the loop can continue without the full step history.

Focus on:
- the current task and sub-goal progress
- the most recent tool calls and their outcomes (verbatim where short)
- any pending tool results the loop is waiting on
- the immediate next step the agent should take

Keep the summary dense and factual. Do not include user messages or prior conversation history — those are summarized separately. Output the summary as plain text, no XML tags.`;

/** 构造 step 摘要 prompt 对。 */
export function buildStepCompactionPrompt(): CompactionPrompt {
  return { system: STEP_COMPACTION_PROMPT_BODY, user: STEP_COMPACTION_PROMPT_BODY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Code-compaction 摘要 prompt（对应 Grok `code_compaction/prompt.rs`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 代码块专用摘要 prompt。
 *
 * Nexus 的 code-compaction 主要是确定性本地压缩（保留签名 + 占位），
 * 但当单块过大、需要 LLM 摘要时使用此 prompt。对应 Grok 的
 * `build_summary_prompt`（grok-build 全量替换摘要）。
 */
export const CODE_COMPACTION_SUMMARY_PROMPT_BODY = `Summarize the code blocks in the conversation so the agent can continue working without the full code bodies.

For each code block:
- preserve the function / class / method signatures verbatim
- replace the implementation body with a one-line intent comment
- keep public type definitions and import statements
- drop redundant boilerplate, comments, and blank lines

Output the condensed code blocks in fenced code blocks with their original language tags. Do not include any prose outside the code blocks.`;

/** 构造 code-compaction 摘要 prompt 对。 */
export function buildCodeCompactionPrompt(): CompactionPrompt {
  return { system: "", user: CODE_COMPACTION_SUMMARY_PROMPT_BODY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-replace 摘要 prompt（对应 Grok `SELF_SUMMARIZATION_PROMPT`）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * grok-build 风格的全量替换摘要 prompt。
 * 对应 Grok `code_compaction::SELF_SUMMARIZATION_PROMPT` ——
 * 作为最后一条 user 消息追加，让模型摘要整段对话。
 */
export const FULL_REPLACE_SUMMARY_PROMPT = `Continue the conversation from a compact summary. The previous conversation ran out of context.

Produce a structured summary following the seven-section format:
1. Primary Request and Intent
2. Key Technical Concepts
3. Tool Usage & Verification
4. Files and Code Sections
5. Errors and Fixes
6. Problem Solving
7. All User Messages

Then indicate the immediate next step. Wrap the summary in <summary>…</summary> tags. Be thorough but dense.`;

/** 构造全量替换摘要 prompt 对。 */
export function buildFullReplaceSummaryPrompt(userContext?: string): CompactionPrompt {
  const user = userContext ? `${FULL_REPLACE_SUMMARY_PROMPT}\n\nAdditional context:\n${userContext}` : FULL_REPLACE_SUMMARY_PROMPT;
  return { system: "", user };
}
