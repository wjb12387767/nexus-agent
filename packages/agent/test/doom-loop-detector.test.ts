import { test, expect, describe, beforeEach } from "bun:test";
import {
	DoomLoopDetector,
	normalizeArgs,
	DEFAULT_DOOM_LOOP_CONFIG,
} from "../src/doom-loop-detector";

describe("DoomLoopDetector", () => {
	let detector: DoomLoopDetector;

	beforeEach(() => {
		// 每个测试用例使用全新的 detector 实例，避免窗口状态污染
		detector = new DoomLoopDetector();
	});

	describe("spec scenarios", () => {
		test("Scenario 1: 连续 3 次相同工具调用应触发告警", () => {
			const args = { file: "foo.ts", old: "bar", new: "baz" };

			detector.recordCall("edit", args);
			expect(detector.detect()).toBeNull();

			detector.recordCall("edit", args);
			expect(detector.detect()).toBeNull();

			detector.recordCall("edit", args);
			const alert = detector.detect();

			expect(alert).not.toBeNull();
			expect(alert!.toolName).toBe("edit");
			expect(alert!.consecutiveCount).toBe(3);
			expect(alert!.message).toContain("edit");
			expect(alert!.message).toContain("3");
			expect(alert!.signature).toBe(normalizeArgs(args));
		});

		test("Scenario 2: 相同工具但参数不同不应触发告警", () => {
			detector.recordCall("bash", { command: "ls" });
			detector.recordCall("bash", { command: "ls -la" });
			detector.recordCall("bash", { command: "ls -l" });

			// 三个调用的 argsSignature 各不相同，连续计数为 1，未达阈值
			expect(detector.detect()).toBeNull();
		});

		test("Scenario 3: 循环解除后窗口重置不再触发", () => {
			detector.recordCall("edit", { file: "a" });
			detector.recordCall("edit", { file: "a" });
			// 第 3 次切换到不同工具，打断连续序列
			detector.recordCall("bash", { command: "ls" });
			// 第 4 次回到 edit，但窗口末尾只有 1 个连续 edit
			detector.recordCall("edit", { file: "a" });

			expect(detector.detect()).toBeNull();
		});
	});

	describe("边界情况", () => {
		test("Scenario 4: windowSize 滑动窗口只保留最后 N 个调用", () => {
			detector = new DoomLoopDetector({ windowSize: 3, threshold: 2 });

			// A, B, A, A：窗口大小 3，最终窗口为 [B, A, A]，A 连续 2 次达阈值
			detector.recordCall("edit", { file: "a" }); // A（将被滑出）
			detector.recordCall("bash", { command: "ls" }); // B
			detector.recordCall("edit", { file: "a" }); // A
			detector.recordCall("edit", { file: "a" }); // A

			// 验证窗口确实只剩 3 个记录
			expect(detector.state.length).toBe(3);

			const alert = detector.detect();
			expect(alert).not.toBeNull();
			expect(alert!.toolName).toBe("edit");
			expect(alert!.consecutiveCount).toBe(2);
		});

		test("Scenario 5: threshold=1 时任意单次调用立即触发", () => {
			detector = new DoomLoopDetector({ threshold: 1 });

			detector.recordCall("edit", { file: "a" });

			const alert = detector.detect();
			expect(alert).not.toBeNull();
			expect(alert!.consecutiveCount).toBe(1);
			expect(alert!.toolName).toBe("edit");
		});

		test("Scenario 6: enabled=false 时禁用检测，连续相同调用也不触发", () => {
			detector = new DoomLoopDetector({ enabled: false });

			const args = { file: "foo.ts", old: "bar", new: "baz" };
			detector.recordCall("edit", args);
			detector.recordCall("edit", args);
			detector.recordCall("edit", args);

			// 禁用时 recordCall 为 no-op，窗口应为空
			expect(detector.state.length).toBe(0);
			expect(detector.detect()).toBeNull();
		});

		test("Scenario 7: 触发告警后自动 reset，再次 detect 返回 null", () => {
			const args = { file: "foo.ts" };

			detector.recordCall("edit", args);
			detector.recordCall("edit", args);
			detector.recordCall("edit", args);

			const firstAlert = detector.detect();
			expect(firstAlert).not.toBeNull();

			// 触发后窗口已清空
			expect(detector.state.length).toBe(0);

			// 再次 detect 应返回 null（窗口为空）
			expect(detector.detect()).toBeNull();

			// 即使再调用 1 次相同参数，连续计数仅 1，未达阈值 3
			detector.recordCall("edit", args);
			expect(detector.detect()).toBeNull();
		});

		test("默认配置导出值符合预期", () => {
			expect(DEFAULT_DOOM_LOOP_CONFIG.windowSize).toBe(10);
			expect(DEFAULT_DOOM_LOOP_CONFIG.threshold).toBe(3);
			expect(DEFAULT_DOOM_LOOP_CONFIG.enabled).toBe(true);

			// 默认构造的 detector 应使用默认配置
			const fresh = new DoomLoopDetector();
			// 通过 enabled=false 路径间接验证默认 threshold=3：连续 2 次不应触发
			fresh.recordCall("edit", { file: "a" });
			fresh.recordCall("edit", { file: "a" });
			expect(fresh.detect()).toBeNull();

			fresh.recordCall("edit", { file: "a" });
			expect(fresh.detect()).not.toBeNull();
		});

		test("手动 reset 清空窗口", () => {
			detector.recordCall("edit", { file: "a" });
			detector.recordCall("edit", { file: "a" });
			expect(detector.state.length).toBe(2);

			detector.reset();
			expect(detector.state.length).toBe(0);
			expect(detector.detect()).toBeNull();
		});
	});

	describe("normalizeArgs", () => {
		test("对象 key 顺序无关：{a:1,b:2} 与 {b:2,a:1} 签名相同", () => {
			expect(normalizeArgs({ a: 1, b: 2 })).toBe(normalizeArgs({ b: 2, a: 1 }));
		});

		test("嵌套对象 key 顺序无关", () => {
			const left = { nested: { x: 1, y: 2 }, other: { c: 3, d: 4 } };
			const right = { other: { d: 4, c: 3 }, nested: { y: 2, x: 1 } };
			expect(normalizeArgs(left)).toBe(normalizeArgs(right));
		});

		test("数组顺序敏感：[1,2,3] 与 [3,2,1] 签名不同", () => {
			expect(normalizeArgs([1, 2, 3])).not.toBe(normalizeArgs([3, 2, 1]));
		});

		test("数组元素递归归一化：内嵌对象 key 顺序无关", () => {
			const left = [{ a: 1, b: 2 }, { c: 3 }];
			const right = [{ b: 2, a: 1 }, { c: 3 }];
			expect(normalizeArgs(left)).toBe(normalizeArgs(right));
		});

		test("undefined 归一化为字符串 'undefined'", () => {
			expect(normalizeArgs(undefined)).toBe("undefined");
		});

		test("null 归一化为字符串 'null'，与 undefined 不同", () => {
			expect(normalizeArgs(null)).toBe("null");
			expect(normalizeArgs(null)).not.toBe(normalizeArgs(undefined));
		});

		test("function 与 symbol 视为 undefined", () => {
			expect(normalizeArgs((() => {}) as unknown)).toBe("undefined");
			expect(normalizeArgs(Symbol("x") as unknown)).toBe("undefined");
		});

		test("bigint 输出带类型标签，不抛错", () => {
			expect(normalizeArgs(42n)).toBe('"bigint:42"');
		});

		test("基本类型按 JSON.stringify 输出", () => {
			expect(normalizeArgs(42)).toBe("42");
			expect(normalizeArgs("hello")).toBe('"hello"');
			expect(normalizeArgs(true)).toBe("true");
		});

		test("循环引用返回固定占位符，不抛错", () => {
			const obj: Record<string, unknown> = { a: 1 };
			obj.self = obj;
			// 不应抛错，且包含 [Circular] 占位符
			const sig = normalizeArgs(obj);
			expect(sig).toContain("[Circular]");
		});
	});
});
