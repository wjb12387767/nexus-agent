/**
 * 代码块专用压缩（code-compaction）
 *
 * 移植自 Grok `xai-grok-compaction/src/code_compaction/`。
 *
 * 核心算法（对齐 Grok `format_compact_summary` 的"保留签名 + 注释占位"思路）：
 * 1. 从消息文本中识别 ```fence 代码块
 * 2. 对行数超过 `codeBlockSize` 的代码块：
 *    - 保留函数/类签名行（声明行）
 *    - 保留第一个和最后一个注释块
 *    - 中间实现细节用 `// ... <N lines elided>` 占位
 * 3. 支持多语言：TS/JS、Python、Rust、Go、Java、C/C++ 等
 *
 * 与 omp compaction 接口兼容：输入 `NexusMessage[]`，输出 `NexusMessage[]`。
 */

import type { NexusMessage, NexusCompactionConfig, ContentBlock } from "./types";

/** Code-compaction 统计 */
export interface CodeCompactionStats {
	applied: boolean;
	/** 压缩的代码块数 */
	blocksCompacted: number;
	/** elided 的总行数 */
	linesElided: number;
	/** 节省的 token 数 */
	tokensSaved: number;
}

// ============================================================================
// 代码块识别
// ============================================================================

/** fenced code block 匹配正则 */
const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;

/** 代码块结构 */
export interface CodeBlock {
	/** 语言标识（如 ts/python/rust） */
	lang: string;
	/** 代码内容（不含 fence 包裹） */
	code: string;
	/** 在原文中的起始偏移 */
	start: number;
	/** 在原文中的结束偏移 */
	end: number;
}

/**
 * 从文本中提取所有 fenced code block。
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	FENCE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCE_RE.exec(text)) !== null) {
		blocks.push({
			lang: (m[1] || "").toLowerCase(),
			code: m[2],
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return blocks;
}

// ============================================================================
// 多语言签名识别
// ============================================================================

/** 通用签名正则：覆盖 TS/JS/Python/Rust/Go/Java/C/C++ */
const SIGNATURE_PATTERNS: RegExp[] = [
	// TS/JS/Java/C/C++: function/class/interface/struct/enum 声明
	/^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|final\s+)* (?:function|class|interface|enum|struct|union|type)\s+\w+/,
	// TS/JS: 箭头函数 / const 函数
	/^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(?[^=]*=>?/,
	// Python: def/class 声明
	/^\s*(?:async\s+)?def\s+\w+|^\s*class\s+\w+/,
	// Rust: fn/struct/enum/impl/trait/mod 声明
	/^\s*(?:pub\s+)?(?:fn|struct|enum|impl|trait|mod|macro_rules!)\s+\w+/,
	// Go: func/type 声明
	/^\s*func\s+(?:\([^)]*\)\s+)?\w+|^\s*type\s+\w+\s/,
	// C#: namespace/class/interface/struct/enum 声明
	/^\s*(?:public|private|protected|internal|static|sealed|abstract)\s+ (?:class|interface|struct|enum|record)\s+\w+/,
];

// 注释行正则：支持 // 和 # 和 /* * */ 等多种形式
const COMMENT_RE = /^\s*(\/\/|#|\/\*|\*|<!--|--|;;)/;

/**
 * 判断一行是否为签名行（函数/类/结构等声明）。
 */
export function isSignatureLine(line: string): boolean {
	return SIGNATURE_PATTERNS.some(re => re.test(line));
}

/**
 * 判断一行是否为注释。
 */
export function isCommentLine(line: string): boolean {
	return COMMENT_RE.test(line);
}

// ============================================================================
// 代码块压缩
// ============================================================================

/**
 * 压缩单个代码块：保留签名 + 首/末注释，中间用占位符替换。
 *
 * 算法：
 * 1. 按行分割
 * 2. 标记每行类型：signature / comment / blank / body
 * 3. 收集"必须保留"的行：所有签名行、首个连续注释块、末个连续注释块
 * 4. 在被省略的连续 body 行区间插入 `// ... <N lines elided>` 占位
 * 5. 保留行号顺序
 *
 * @param code 原始代码文本
 * @param maxLines 触发压缩的行数阈值
 * @returns 压缩后代码 + 被省略的行数
 */
export function compactCodeBlock(code: string, maxLines: number): {
	code: string;
	linesElided: number;
} {
	const lines = code.split("\n");
	if (lines.length <= maxLines) {
		return { code, linesElided: 0 };
	}

	// Step 1: 标记每行类型
	type LineKind = "signature" | "comment" | "blank" | "body";
	const kinds: LineKind[] = lines.map(line => {
		if (!line.trim()) return "blank";
		if (isCommentLine(line)) return "comment";
		if (isSignatureLine(line)) return "signature";
		return "body";
	});

	// Step 2: 找首个连续注释块和末个连续注释块的边界
	let firstCommentEnd = -1;
	for (let i = 0; i < lines.length; i++) {
		if (kinds[i] === "comment") {
			firstCommentEnd = i;
		} else if (kinds[i] !== "blank" && firstCommentEnd >= 0) {
			break;
		} else if (kinds[i] === "blank" && firstCommentEnd < 0) {
			// 前导空行继续
			continue;
		} else if (kinds[i] !== "blank" && kinds[i] !== "comment" && firstCommentEnd < 0) {
			break;
		}
	}

	let lastCommentStart = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (kinds[i] === "comment") {
			lastCommentStart = i;
		} else if (kinds[i] !== "blank" && lastCommentStart >= 0) {
			break;
		} else if (kinds[i] === "blank" && lastCommentStart < 0) {
			continue;
		} else if (kinds[i] !== "blank" && kinds[i] !== "comment" && lastCommentStart < 0) {
			break;
		}
	}

	// Step 3: 标记保留行
	const keep = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		if (kinds[i] === "signature") keep[i] = true;
		if (i <= firstCommentEnd && firstCommentEnd >= 0 && kinds[i] !== "body") keep[i] = true;
		if (i >= lastCommentStart && lastCommentStart >= 0 && kinds[i] !== "body") keep[i] = true;
	}

	// Step 4: 始终保留首 3 行 + 末 2 行（语言习惯：import / package / return 等）
	for (let i = 0; i < Math.min(3, lines.length); i++) keep[i] = true;
	for (let i = Math.max(0, lines.length - 2); i < lines.length; i++) keep[i] = true;

	// Step 5: 生成输出，对连续省略区间插入占位
	const out: string[] = [];
	let elidedRun = 0;
	let totalElided = 0;
	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			if (elidedRun > 0) {
				out.push(`// ... <${elidedRun} lines elided>`);
				totalElided += elidedRun;
				elidedRun = 0;
			}
			out.push(lines[i]);
		} else {
			elidedRun++;
		}
	}
	if (elidedRun > 0) {
		out.push(`// ... <${elidedRun} lines elided>`);
		totalElided += elidedRun;
	}

	return { code: out.join("\n"), linesElided: totalElided };
}

// ============================================================================
// 消息级处理
// ============================================================================

/**
 * 压缩消息文本中的所有超长代码块。
 *
 * 对每条消息：
 * 1. 提取纯文本（string content 或首个 text block）
 * 2. 找出所有 fenced code block
 * 3. 对超过阈值的代码块做签名保留压缩
 * 4. 用压缩后文本替换原文
 *
 * 注意：仅处理 text/string content；不修改 thinking / toolCall / toolResult 块。
 */
export function compactCodeInMessage(
	message: NexusMessage,
	maxLines: number,
): { message: NexusMessage; blocksCompacted: number; linesElided: number } {
	const role = (message as { role?: string }).role;
	// 仅处理可能含代码的消息
	if (role === "system" || role === "toolResult") {
		// toolResult / system 中的代码也应处理
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		const { text, blocksCompacted, linesElided } = compactCodeInText(content, maxLines);
		if (blocksCompacted === 0) return { message, blocksCompacted: 0, linesElided: 0 };
		return { message: { ...message, content: text } as NexusMessage, blocksCompacted, linesElided };
	}
	if (Array.isArray(content)) {
		let blocksCompacted = 0;
		let linesElided = 0;
		const newContent: ContentBlock[] = content.map((block: unknown) => {
			if (!block || typeof block !== "object") return block as ContentBlock;
			const b = block as { type?: string; text?: string };
			if (b.type !== "text" || typeof b.text !== "string") return block as ContentBlock;
			const r = compactCodeInText(b.text, maxLines);
			blocksCompacted += r.blocksCompacted;
			linesElided += r.linesElided;
			return r.blocksCompacted > 0 ? ({ ...block, text: r.text } as ContentBlock) : (block as ContentBlock);
		});
		if (blocksCompacted === 0) return { message, blocksCompacted: 0, linesElided: 0 };
		return { message: { ...message, content: newContent } as NexusMessage, blocksCompacted, linesElided };
	}
	// branchSummary / compactionSummary 的 summary 字段也压缩
	if (role === "compactionSummary" || role === "branchSummary") {
		const summary = (message as { summary?: string }).summary;
		if (typeof summary === "string") {
			const r = compactCodeInText(summary, maxLines);
			if (r.blocksCompacted === 0) return { message, blocksCompacted: 0, linesElided: 0 };
			return {
				message: { ...message, summary: r.text, content: r.text } as NexusMessage,
				blocksCompacted: r.blocksCompacted,
				linesElided: r.linesElided,
			};
		}
	}
	return { message, blocksCompacted: 0, linesElided: 0 };
}

/**
 * 压缩文本中的所有超长代码块。
 */
export function compactCodeInText(text: string, maxLines: number): {
	text: string;
	blocksCompacted: number;
	linesElided: number;
} {
	const blocks = extractCodeBlocks(text);
	if (blocks.length === 0) return { text, blocksCompacted: 0, linesElided: 0 };

	let result = "";
	let cursor = 0;
	let blocksCompacted = 0;
	let totalElided = 0;

	for (const block of blocks) {
		const lineCount = block.code.split("\n").length;
		if (lineCount <= maxLines) {
			// 不需要压缩，原样保留
			result += text.slice(cursor, block.end);
			cursor = block.end;
			continue;
		}
		// 压缩
		result += text.slice(cursor, block.start);
		const { code: compacted, linesElided } = compactCodeBlock(block.code, maxLines);
		result += "```" + block.lang + "\n" + compacted + "\n```";
		cursor = block.end;
		blocksCompacted++;
		totalElided += linesElided;
	}
	result += text.slice(cursor);

	return { text: result, blocksCompacted, linesElided: totalElided };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 执行 code-compaction（代码块专用压缩）。
 *
 * 遍历所有消息，对其中超长的 fenced code block 做签名保留压缩。
 *
 * 与 omp compaction 接口兼容：输入 `NexusMessage[]`，输出 `NexusMessage[]`。
 */
export function codeCompaction(
	messages: NexusMessage[],
	config: NexusCompactionConfig,
): { messages: NexusMessage[]; stats: CodeCompactionStats } {
	let totalBlocks = 0;
	let totalElided = 0;
	const result = messages.map(msg => {
		const { message: newMsg, blocksCompacted, linesElided } = compactCodeInMessage(msg, config.codeBlockSize);
		totalBlocks += blocksCompacted;
		totalElided += linesElided;
		return newMsg;
	});

	// 每行约 8 token（混合代码）
	const tokensSaved = totalElided * 8;

	return {
		messages: result,
		stats: {
			applied: totalBlocks > 0,
			blocksCompacted: totalBlocks,
			linesElided: totalElided,
			tokensSaved,
		},
	};
}
