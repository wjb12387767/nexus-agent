import { describe, expect, it } from "bun:test";
import { StreamingThinkScrubber } from "@oh-my-pi/pi-ai/utils/leaked-thinking-stream";

/** 便捷工具：单次 feed + flush，返回清洗后的完整文本。 */
function scrubOnce(text: string): string {
	const s = new StreamingThinkScrubber();
	const fed = s.feed(text);
	const flushed = s.flush();
	return fed + flushed;
}

/** 便捷工具：按 delta 数组逐段 feed，最后 flush，返回拼接的清洗文本。 */
function scrubDeltas(deltas: string[]): string {
	const s = new StreamingThinkScrubber();
	let out = "";
	for (const d of deltas) out += s.feed(d);
	out += s.flush();
	return out;
}

describe("StreamingThinkScrubber", () => {
	describe("基础标签清洗", () => {
		it("吞掉完整的 <think>...</think> 块", () => {
			const input = "Hello <think>secret reasoning</think> World";
			expect(scrubOnce(input)).toBe("Hello  World");
		});

		it("吞掉行首的 <think> 块（boundary-gated）", () => {
			const input = "Line one\n<think>hidden</think>\nLine two";
			expect(scrubOnce(input)).toBe("Line one\n\nLine two");
		});

		it("保留不含标签的正常文本", () => {
			expect(scrubOnce("Just regular text")).toBe("Just regular text");
		});

		it("空文本返回空", () => {
			const s = new StreamingThinkScrubber();
			expect(s.feed("")).toBe("");
			expect(s.flush()).toBe("");
		});
	});

	describe("多标签变体", () => {
		it("吞掉 <thinking>...</thinking>", () => {
			expect(scrubOnce("<thinking>deep thoughts</thinking>")).toBe("");
		});

		it("吞掉 <reasoning>...</reasoning>", () => {
			expect(scrubOnce("Hi <reasoning>step by step</reasoning> Bye")).toBe("Hi  Bye");
		});

		it("吞掉 <thought>...</thought>", () => {
			expect(scrubOnce("<thought>my thought</thought>")).toBe("");
		});

		it("吞掉 <REASONING_SCRATCHPAD>...</REASONING_SCRATCHPAD>", () => {
			expect(scrubOnce("<REASONING_SCRATCHPAD>scratch</REASONING_SCRATCHPAD>")).toBe("");
		});

		it("大小写不敏感匹配 <ThInK>...</ThInK>", () => {
			expect(scrubOnce("<ThInK>mixed case</ThInK>")).toBe("");
		});

		it("大小写不敏感匹配 <Reasoning>...</REASONING>", () => {
			expect(scrubOnce("<Reasoning>case mismatch</REASONING>")).toBe("");
		});
	});

	describe("跨 delta 拆分标签", () => {
		it("开标签跨 delta 拆分时正确拼接", () => {
			const deltas = ["Hello <thi", "nk>hidden</think> World"];
			expect(scrubDeltas(deltas)).toBe("Hello  World");
		});

		it("闭标签跨 delta 拆分时正确拼接", () => {
			const deltas = ["<think>hidden</thi", "nk> World"];
			expect(scrubDeltas(deltas)).toBe(" World");
		});

		it("标签名跨 delta 拆分", () => {
			const deltas = ["<rea", "soning>logic</reasoning> done"];
			expect(scrubDeltas(deltas)).toBe(" done");
		});

		it("整个标签跨多个 delta", () => {
			const deltas = ["<", "think", ">", "secret", "</", "think", ">"];
			expect(scrubDeltas(deltas)).toBe("");
		});

		it("partial suffix 持回不以 < 开头时不影响输出", () => {
			const deltas = ["hello world", " foo"];
			expect(scrubDeltas(deltas)).toBe("hello world foo");
		});

		it("partial suffix < 后续非标签前缀时正常 emit", () => {
			const deltas = ["text < ", "more"];
			expect(scrubDeltas(deltas)).toBe("text < more");
		});
	});

	describe("prose 内联提及不被吞", () => {
		it("非 boundary 位置（前面是非空字符）的 <think> 不被视为块开始", () => {
			const input = "Use the word<think>here as prose.";
			// "word" 后面的 <think> 不是 boundary（前面是 'd'），所以不被视为块开始
			// 没有闭标签，所以整个文本原样输出
			expect(scrubOnce(input)).toBe("Use the word<think>here as prose.");
		});

		it("词中提及 think 不被吞", () => {
			const input = "I was <thinking> about this";
			// "<thinking>" 前面是空格，所以是 boundary — 会被视为块开始
			// 但没有闭标签，flush 时块内容被丢弃
			expect(scrubOnce(input)).toBe("I was ");
		});

		it("紧邻非空字符的 <think> 不被视为块开始", () => {
			const input = "x<think>hidden</think> y";
			// "x" 后面的 <think> 不是 boundary（前面是 'x'），所以不被视为块开始
			// 但闭合对 <think>...</think> 始终被吞
			expect(scrubOnce(input)).toBe("x y");
		});
	});

	describe("闭合对始终被吞", () => {
		it("非 boundary 位置的闭合对仍被吞", () => {
			const input = "foo<think>bar</think>baz";
			expect(scrubOnce(input)).toBe("foobaz");
		});

		it("多个闭合对都被吞", () => {
			const input = "<think>a</think>mid<thinking>b</thinking>";
			expect(scrubOnce(input)).toBe("mid");
		});

		it("嵌套标签名不同的闭合对", () => {
			const input = "<think>outer <reasoning>inner</reasoning> rest</think> visible";
			expect(scrubOnce(input)).toBe(" visible");
		});
	});

	describe("orphan close tag 清理", () => {
		it("feed+flush 清理残留的 orphan </think>", () => {
			// feed 阶段即吞掉 orphan </think>，返回已清洗的可见文本；
			// flush 时 buf 已空，返回 ""。合并即为最终清洗结果。
			const s = new StreamingThinkScrubber();
			const fed = s.feed("text with </think> orphan");
			const flushed = s.flush();
			expect(fed + flushed).toBe("text with  orphan");
		});

		it("feed 中不产生 orphan close tag 泄漏", () => {
			const input = "before </thinking> after";
			expect(scrubOnce(input)).toBe("before  after");
		});

		it("多个 orphan close tag 都被清理", () => {
			const input = "</think> start </reasoning> end";
			expect(scrubOnce(input)).toBe(" start  end");
		});
	});

	describe("flush 重置", () => {
		it("flush 后 inBlock 为 false", () => {
			const s = new StreamingThinkScrubber();
			s.feed("<think>entered block");
			expect(s.inBlock).toBe(true);
			s.flush();
			expect(s.inBlock).toBe(false);
		});

		it("flush 后再 feed 行为正常（状态已重置）", () => {
			const s = new StreamingThinkScrubber();
			s.feed("<think>block one");
			s.flush();
			// flush 后 lastEmittedEndedNewline = true，新文本行首 <think> 是 boundary
			const out = s.feed("<think>block two</think>visible");
			expect(out).toBe("visible");
		});

		it("未关闭的块内容在 flush 时被丢弃", () => {
			const s = new StreamingThinkScrubber();
			const out1 = s.feed("visible <think>hidden content not closed");
			expect(out1).toBe("visible ");
			const out2 = s.flush();
			expect(out2).toBe("");
		});
	});

	describe("reset 方法", () => {
		it("reset 后状态恢复初始", () => {
			const s = new StreamingThinkScrubber();
			s.feed("<think>in block");
			expect(s.inBlock).toBe(true);
			s.reset();
			expect(s.inBlock).toBe(false);
			// reset 后 feed 正常
			expect(s.feed("hello")).toBe("hello");
		});
	});

	describe("复杂场景", () => {
		it("混合标签的复杂流", () => {
			const input = [
				"<think>first thought</think>",
				" visible text ",
				"<reasoning>second</reasoning>",
				" more visible",
			].join("");
			expect(scrubOnce(input)).toBe(" visible text  more visible");
		});

		it("连续块之间有换行", () => {
			const input = "<think>a</think>\n<think>b</think>\ntext";
			expect(scrubOnce(input)).toBe("\n\ntext");
		});

		it("块内有伪标签文本（不匹配）", () => {
			const input = "<think>contains <not_a_tag> text</think> visible";
			expect(scrubOnce(input)).toBe(" visible");
		});

		it("streaming 场景：逐字符 feed", () => {
			const text = "Hi <think>hidden</think> Bye";
			let result = "";
			const s = new StreamingThinkScrubber();
			for (const ch of text) result += s.feed(ch);
			result += s.flush();
			expect(result).toBe("Hi  Bye");
		});
	});
});
