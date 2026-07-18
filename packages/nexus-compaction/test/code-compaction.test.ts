/**
 * code-compaction 单测
 *
 * 覆盖：
 * - extractCodeBlocks：fenced code block 提取
 * - isSignatureLine：多语言签名识别（TS/JS/Python/Rust/Go/Java/C/C++/C#）
 * - isCommentLine：注释识别
 * - compactCodeBlock：保留签名 + 首/末注释，中间省略
 * - compactCodeInText：多代码块文本处理
 * - codeCompaction：端到端（消息数组）
 */
import { describe, expect, test } from "bun:test";
import {
	type NexusMessage,
	type NexusCompactionConfig,
	DEFAULT_NEXUS_CONFIG,
} from "../src/types";
import {
	codeCompaction,
	compactCodeBlock,
	compactCodeInText,
	compactCodeInMessage,
	extractCodeBlocks,
	isSignatureLine,
	isCommentLine,
} from "../src/code-compaction";

// ============================================================
// 测试夹具
// ============================================================

const config: NexusCompactionConfig = { ...DEFAULT_NEXUS_CONFIG, codeBlockSize: 10 };

function userMsg(text: string): NexusMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function userMsgBlocks(text: string): NexusMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}
function fence(lang: string, code: string): string {
	return "```" + lang + "\n" + code + "\n```";
}

// ============================================================
// extractCodeBlocks
// ============================================================

describe("extractCodeBlocks", () => {
	test("提取单个 fenced block", () => {
		const text = fence("ts", "const x = 1;");
		const blocks = extractCodeBlocks(text);
		expect(blocks.length).toBe(1);
		expect(blocks[0].lang).toBe("ts");
		expect(blocks[0].code).toBe("const x = 1;\n");
	});

	test("提取多个 fenced block", () => {
		const text = `${fence("ts", "a")}\n\n中间文本\n\n${fence("python", "b")}`;
		const blocks = extractCodeBlocks(text);
		expect(blocks.length).toBe(2);
		expect(blocks[0].lang).toBe("ts");
		expect(blocks[1].lang).toBe("python");
	});

	test("无 fence 时返回空数组", () => {
		expect(extractCodeBlocks("plain text")).toEqual([]);
	});

	test("start/end 偏移正确", () => {
		const text = `before\n${fence("ts", "x")}\nafter`;
		const blocks = extractCodeBlocks(text);
		expect(blocks.length).toBe(1);
		expect(text.slice(blocks[0].start, blocks[0].end)).toBe(fence("ts", "x"));
	});
});

// ============================================================
// isSignatureLine（多语言）
// ============================================================

describe("isSignatureLine —— 多语言签名识别", () => {
	test("TS/JS function 声明", () => {
		expect(isSignatureLine("function foo() {")).toBe(true);
		expect(isSignatureLine("export function bar(): void {")).toBe(true);
		expect(isSignatureLine("async function baz(): Promise<number> {")).toBe(true);
	});

	test("TS/JS class/interface 声明", () => {
		expect(isSignatureLine("class Foo {")).toBe(true);
		expect(isSignatureLine("export class Bar extends Base {")).toBe(true);
		expect(isSignatureLine("interface IReader {")).toBe(true);
	});

	test("TS/JS 箭头函数 / const 函数", () => {
		expect(isSignatureLine("const fn = (x: number) => x + 1;")).toBe(true);
		expect(isSignatureLine("export const handler = async (req: Request) => {")).toBe(true);
	});

	test("Python def/class 声明", () => {
		expect(isSignatureLine("def foo(x: int) -> str:")).toBe(true);
		expect(isSignatureLine("async def bar():")).toBe(true);
		expect(isSignatureLine("class MyClass:")).toBe(true);
	});

	test("Rust fn/struct/enum/impl/trait/mod 声明", () => {
		expect(isSignatureLine("fn foo(x: i32) -> i32 {")).toBe(true);
		expect(isSignatureLine("pub fn bar() {")).toBe(true);
		expect(isSignatureLine("struct Point {")).toBe(true);
		expect(isSignatureLine("enum Color {")).toBe(true);
		expect(isSignatureLine("impl Foo {")).toBe(true);
		expect(isSignatureLine("trait Reader {")).toBe(true);
		expect(isSignatureLine("mod utils {")).toBe(true);
	});

	test("Go func/type 声明", () => {
		expect(isSignatureLine("func foo(x int) int {")).toBe(true);
		expect(isSignatureLine("func (s *Server) Start() error {")).toBe(true);
		expect(isSignatureLine("type Reader interface {")).toBe(true);
	});

	test("Java/C#/C++ class 声明", () => {
		expect(isSignatureLine("public class Foo {")).toBe(true);
		expect(isSignatureLine("private class Bar {")).toBe(true);
		expect(isSignatureLine("public interface IReader {")).toBe(true);
	});

	test("普通代码行不被识别为签名", () => {
		expect(isSignatureLine("return x + 1;")).toBe(false);
		expect(isSignatureLine("console.log('hello');")).toBe(false);
		expect(isSignatureLine("x = x + 1")).toBe(false);
		expect(isSignatureLine("// comment")).toBe(false);
	});
});

// ============================================================
// isCommentLine
// ============================================================

describe("isCommentLine —— 多语言注释识别", () => {
	test("// 单行注释（TS/JS/Rust/Go/Java/C/C++/C#）", () => {
		expect(isCommentLine("// hello")).toBe(true);
		expect(isCommentLine("  // indented")).toBe(true);
	});

	test("# 单行注释（Python/Ruby/Shell）", () => {
		expect(isCommentLine("# hello")).toBe(true);
		expect(isCommentLine("  # indented")).toBe(true);
	});

	test("/* */ 块注释", () => {
		expect(isCommentLine("/* block start")).toBe(true);
		expect(isCommentLine(" * middle")).toBe(true);
		expect(isCommentLine(" */ end")).toBe(true);
	});

	test("HTML 注释", () => {
		expect(isCommentLine("<!-- html comment")).toBe(true);
		expect(isCommentLine("--> end")).toBe(true);
	});

	test("Lisp 注释 ;;", () => {
		expect(isCommentLine(";; lisp comment")).toBe(true);
	});

	test("普通代码行不被识别为注释", () => {
		expect(isCommentLine("const x = 1;")).toBe(false);
		expect(isCommentLine("function foo() {")).toBe(false);
	});
});

// ============================================================
// compactCodeBlock
// ============================================================

describe("compactCodeBlock", () => {
	test("短代码块不压缩", () => {
		const code = "const x = 1;\nconst y = 2;\n";
		const { code: out, linesElided } = compactCodeBlock(code, 10);
		expect(out).toBe(code);
		expect(linesElided).toBe(0);
	});

	test("长代码块压缩：保留签名 + 占位符", () => {
		// 生成 30 行代码，含签名
		const lines = [
			"function foo(x: number): number {",
			...Array.from({ length: 25 }, (_, i) => `  const a${i} = ${i};`),
			"  return x;",
			"}",
		];
		const code = lines.join("\n");
		const { code: out, linesElided } = compactCodeBlock(code, 10);
		expect(linesElided).toBeGreaterThan(0);
		// 签名行保留
		expect(out).toContain("function foo(x: number): number {");
		// 占位符存在
		expect(out).toContain("lines elided");
		// 输出比原代码短
		expect(out.length).toBeLessThan(code.length);
	});

	test("保留首尾注释块", () => {
		const lines = [
			"// Header comment",
			"// second line of header",
			"function foo() {",
			...Array.from({ length: 20 }, (_, i) => `  const a${i} = ${i};`),
			"  return 0;",
			"}",
			"// Footer comment",
		];
		const code = lines.join("\n");
		const { code: out } = compactCodeBlock(code, 10);
		expect(out).toContain("Header comment");
		expect(out).toContain("Footer comment");
	});

	test("Python 长函数压缩", () => {
		const lines = [
			"def process_data(items: list) -> dict:",
			...Array.from({ length: 20 }, (_, i) => `    x${i} = ${i}`),
			"    return {}",
		];
		const code = lines.join("\n");
		const { code: out, linesElided } = compactCodeBlock(code, 10);
		expect(linesElided).toBeGreaterThan(0);
		expect(out).toContain("def process_data(items: list) -> dict:");
	});

	test("Rust 长函数压缩", () => {
		const lines = [
			"pub fn process_data(items: Vec<i32>) -> i32 {",
			...Array.from({ length: 20 }, (_, i) => `    let x${i} = ${i};`),
			"    0",
			"}",
		];
		const code = lines.join("\n");
		const { code: out, linesElided } = compactCodeBlock(code, 10);
		expect(linesElided).toBeGreaterThan(0);
		expect(out).toContain("pub fn process_data(items: Vec<i32>) -> i32 {");
	});

	test("Go 长函数压缩", () => {
		const lines = [
			"func process(items []int) int {",
			...Array.from({ length: 20 }, (_, i) => `\tx${i} := ${i}`),
			"\treturn 0",
			"}",
		];
		const code = lines.join("\n");
		const { code: out, linesElided } = compactCodeBlock(code, 10);
		expect(linesElided).toBeGreaterThan(0);
		expect(out).toContain("func process(items []int) int {");
	});
});

// ============================================================
// compactCodeInText
// ============================================================

describe("compactCodeInText", () => {
	test("含多个长代码块的文本", () => {
		const longCode1 = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const longCode2 = Array.from({ length: 20 }, (_, i) => `b${i} = ${i}`).join("\n");
		const text = `intro
${fence("ts", longCode1)}
middle
${fence("python", longCode2)}
outro`;
		const { text: out, blocksCompacted, linesElided } = compactCodeInText(text, 10);
		expect(blocksCompacted).toBe(2);
		expect(linesElided).toBeGreaterThan(0);
		expect(out).toContain("intro");
		expect(out).toContain("outro");
		expect(out).toContain("lines elided");
	});

	test("短代码块不压缩", () => {
		const text = fence("ts", "const x = 1;");
		const { blocksCompacted, linesElided } = compactCodeInText(text, 10);
		expect(blocksCompacted).toBe(0);
		expect(linesElided).toBe(0);
	});

	test("无代码块的文本原样返回", () => {
		const text = "just plain text";
		const { text: out, blocksCompacted } = compactCodeInText(text, 10);
		expect(out).toBe(text);
		expect(blocksCompacted).toBe(0);
	});
});

// ============================================================
// compactCodeInMessage
// ============================================================

describe("compactCodeInMessage", () => {
	test("string content 处理", () => {
		const longCode = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const msg = userMsg(fence("ts", longCode));
		const { message, blocksCompacted } = compactCodeInMessage(msg, 10);
		expect(blocksCompacted).toBe(1);
		const content = (message as { content: string }).content;
		expect(content).toContain("lines elided");
	});

	test("array content 处理", () => {
		const longCode = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const msg = userMsgBlocks(fence("ts", longCode));
		const { message, blocksCompacted } = compactCodeInMessage(msg, 10);
		expect(blocksCompacted).toBe(1);
		const block = (message as { content: Array<{ type: string; text?: string }> }).content[0];
		expect(block.text).toContain("lines elided");
	});

	test("compactionSummary 的 summary 字段处理", () => {
		const longCode = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const msg: NexusMessage = {
			role: "compactionSummary",
			summary: fence("ts", longCode),
			content: fence("ts", longCode),
			timestamp: 0,
		} as NexusMessage;
		const { message, blocksCompacted } = compactCodeInMessage(msg, 10);
		expect(blocksCompacted).toBe(1);
		expect((message as { summary: string }).summary).toContain("lines elided");
	});
});

// ============================================================
// codeCompaction（端到端）
// ============================================================

describe("codeCompaction", () => {
	test("端到端：消息数组中的长代码块被压缩", () => {
		const longCode = Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const msgs: NexusMessage[] = [
			userMsg(`Here's the code:\n${fence("ts", longCode)}`),
			{ role: "assistant", content: [{ type: "text", text: `Result:\n${fence("ts", longCode)}` }], timestamp: 0 },
		];
		const { messages, stats } = codeCompaction(msgs, config);
		expect(stats.applied).toBe(true);
		expect(stats.blocksCompacted).toBe(2);
		expect(stats.linesElided).toBeGreaterThan(0);
		expect(stats.tokensSaved).toBeGreaterThan(0);
		// 输出消息中包含占位符
		for (const m of messages) {
			const c = (m as { content?: unknown }).content;
			if (typeof c === "string") {
				expect(c).toContain("lines elided");
			} else if (Array.isArray(c)) {
				const text = c.find((b: unknown) => (b as { type?: string })?.type === "text");
				if (text) expect((text as { text: string }).text).toContain("lines elided");
			}
		}
	});

	test("无代码块时 applied=false", () => {
		const msgs: NexusMessage[] = [userMsg("just plain text, no code")];
		const { stats } = codeCompaction(msgs, config);
		expect(stats.applied).toBe(false);
	});

	test("短代码块不压缩", () => {
		const msgs: NexusMessage[] = [userMsg(fence("ts", "const x = 1;"))];
		const { stats } = codeCompaction(msgs, config);
		expect(stats.applied).toBe(false);
	});

	test("不修改输入数组", () => {
		const longCode = Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`).join("\n");
		const original = userMsg(fence("ts", longCode));
		const originalText = (original.content as string);
		const originalArray = [original];
		codeCompaction(originalArray, config);
		expect((originalArray[0].content as string)).toBe(originalText);
	});
});
