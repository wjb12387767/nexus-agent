/**
 * 尾部保留选择器 —— 决定从哪里把历史一切为二：旧的部分压缩、新的部分原样保留。
 *
 * 对应 Grok `xai-grok-compaction/src/select.rs` 的 `select_turns_to_compact`。
 * 算法核心完全保留：
 *
 * 1. 从最新项向前走，累加「保留」token 直到达到 `targetTokens` 预算。
 * 2. 候选切分点若落在 tool 结果项上，**向前 snap** 直到越过同一组 tool
 *    结果项 —— 否则会在下一个 prompt 里产生孤儿 tool 结果，被模型 API
 *    以 400 拒绝。
 * 3. 若切分后可压缩区 token 不足 `minCompactable`，返回 `null` ——
 *    LLM 开销大于收益，不压缩。
 */

import type { CompactionItem, ItemTokenCounter } from "./types";

/** 切分计划。对应 Grok `SplitPlan`。 */
export interface SplitPlan {
  /** 压缩索引 `[0, splitIdx)`；保留 `[splitIdx, total)`。 */
  splitIdx: number;
  /** `itemTokenCounts[0..splitIdx]` 之和。 */
  tokensToCompact: number;
}

/**
 * 决定切分点。
 *
 * 算法：
 * 1. 从最新项向前累加「保留」token，找到加入后即超 `targetTokens` 的位置。
 * 2. **向前 snap** 到安全边界：若候选落在 tool 结果项上，向前走到越过
 *    同一 run 的最后一个 tool 结果项。
 * 3. 若结果可压缩 token < `minCompactable`，返回 `null`。
 *
 * # Tool-pair 边界安全
 *
 * 典型序列：
 * ```text
 * [Assistant(tool_req_A, tool_req_B),
 *  Tool(A_result),
 *  Tool(B_result),
 *  Assistant(response_text),
 *  Assistant(tool_req_C),
 *  Tool(C_result),
 *  ...]
 * ```
 *
 * 安全切分点 = 切分之前的内容自包含（没有等待切分后结果的 tool 请求）。
 * 本函数强制：切分索引不能落在 `[Assistant-with-tool-requests, Tool, Tool, ...]`
 * run 中间；若候选落在 tool 结果项上，向前走到该 run 之后。
 */
export function selectTurnsToCompact<I extends CompactionItem>(
  itemTokenCounts: readonly number[],
  items: readonly I[],
  targetTokens: number,
  minCompactable: number,
): SplitPlan | null {
  if (itemTokenCounts.length !== items.length) {
    throw new Error(
      `selectTurnsToCompact: tokenCounts 长度 (${itemTokenCounts.length}) 与 items 长度 (${items.length}) 不一致`,
    );
  }
  const total = items.length;
  if (total === 0) return null;

  // 1. 从最新项向前走，累加「保留」token。
  let kept = 0;
  let splitIdx = total; // 起始「不压缩」
  for (let i = total - 1; i >= 0; i--) {
    const count = itemTokenCounts[i];
    if (kept + count > targetTokens) {
      splitIdx = i + 1;
      break;
    }
    kept += count;
    splitIdx = i;
  }

  // 全部都能塞进预算 → 不压缩。
  if (splitIdx === 0) return null;

  // 2. 向前 snap 到安全边界。
  const safeSplitIdx = snapToSafeBoundary(items, splitIdx);
  if (safeSplitIdx >= total) return null;

  // 3. 计算可压缩 token，检查下限。
  let tokensToCompact = 0;
  for (let i = 0; i < safeSplitIdx; i++) tokensToCompact += itemTokenCounts[i];

  if (tokensToCompact < minCompactable) return null;

  return { splitIdx: safeSplitIdx, tokensToCompact };
}

/**
 * 若 `candidate` 落在 tool 结果项上，向前走过同一 run 的所有 tool 结果项。
 * 实际效果：确保切分落在 assistant/user/system/developer 之前，而绝不落在
 * 「带 tool 请求的 assistant」与它的 tool 结果之间。
 */
function snapToSafeBoundary<I extends CompactionItem>(
  items: readonly I[],
  candidate: number,
): number {
  const total = items.length;
  if (candidate >= total) return total;
  // 候选不是 tool 结果 → 无需 snap。
  if (!items[candidate].isToolResult()) return candidate;
  // 候选是 tool 结果：向前走过连续的 tool 结果 run。
  let idx = candidate;
  while (idx < total && items[idx].isToolResult()) idx++;
  return idx;
}
