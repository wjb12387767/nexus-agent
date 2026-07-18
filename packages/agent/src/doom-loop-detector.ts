/**
 * 通用跨工具/跨 turn 循环调用检测器。
 *
 * 跟踪最近 N 个 (toolName, argsSignature) 调用组成的滑动窗口，
 * 当窗口末尾出现连续 K 个完全相同签名的调用时触发告警，并在触发后自动清空窗口，
 * 避免对同一循环重复告警。
 *
 * 与 hashline/noop-loop-guard 的区别：后者只针对单文件 byte-identical no-op 编辑；
 * 本模块对任意工具调用做通用检测，覆盖所有 toolName，不区分具体语义。
 *
 * 设计目标：零外部依赖（不 import omp logger），纯 TypeScript，便于单测。
 */

/** 滑动窗口中单条工具调用记录。 */
export interface ToolCallRecord {
	toolName: string;
	signature: string;
	timestamp: number;
}

/** 检测器配置。 */
export interface DoomLoopConfig {
	/** 滑动窗口大小（跟踪最近 N 个调用），默认 10 */
	windowSize: number;
	/** 触发阈值（连续 K 个相同签名触发），默认 3 */
	threshold: number;
	/** 是否启用，默认 true */
	enabled: boolean;
}

/** 默认配置。 */
export const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
	windowSize: 10,
	threshold: 3,
	enabled: true,
};

/** 触发循环时返回的告警对象。 */
export interface DoomLoopAlert {
	/** 触发的工具名 */
	toolName: string;
	/** 触发时的连续次数（>= threshold） */
	consecutiveCount: number;
	/** 触发循环的签名（用于调试） */
	signature: string;
	/** 注入给模型的提示消息 */
	message: string;
}

/**
 * 归一化工具调用参数，生成稳定签名。
 *
 * 递归排序对象的所有 key（包括嵌套对象），使 `{a:1,b:2}` 与 `{b:2,a:1}`
 * 产生相同签名。数组保持元素顺序，但元素本身递归归一化。
 * undefined / function / symbol 一律视为 undefined，避免签名漂移。
 * 含循环引用时输出固定占位符，不抛错。
 */
export function normalizeArgs(args: unknown): string {
	return stableStringify(args, new WeakSet<object>());
}

/**
 * 递归构造稳定 JSON 字符串。
 *
 * 不直接用 `JSON.stringify(args, Object.keys(args).sort())` 是因为该写法
 * 只排序根对象 key，嵌套对象仍按原始插入顺序输出，签名不稳定。
 * 这里手工遍历，对每一层对象的 key 都做 sort，再拼接成合法 JSON。
 */
function stableStringify(value: unknown, seen: WeakSet<object>): string {
	// undefined / function / symbol → 统一视为 undefined
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return "undefined";
	}
	if (value === null) return "null";
	if (typeof value === "bigint") {
		// JSON.stringify 对 bigint 会抛错，转成带类型标签的字符串
		return `"bigint:${value.toString()}"`;
	}
	if (typeof value !== "object") {
		// number / string / boolean：直接用 JSON.stringify 处理基本类型
		return JSON.stringify(value);
	}
	// 到这里 typeof === "object"
	const obj = value as object;
	if (seen.has(obj)) return '"[Circular]"';
	seen.add(obj);

	if (Array.isArray(value)) {
		// 数组保持元素顺序，但每个元素递归归一化
		const items = value.map(item => stableStringify(item, seen));
		return `[${items.join(",")}]`;
	}
	// 普通对象：递归排序所有 key
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const pairs = keys.map(k => `${JSON.stringify(k)}:${stableStringify(record[k], seen)}`);
	return `{${pairs.join(",")}}`;
}

/**
 * 通用循环检测器。无外部依赖，线程不安全（单 agent loop 串行使用即可）。
 */
export class DoomLoopDetector {
	private readonly config: DoomLoopConfig;
	private window: ToolCallRecord[] = [];

	constructor(config?: Partial<DoomLoopConfig>) {
		this.config = { ...DEFAULT_DOOM_LOOP_CONFIG, ...config };
	}

	/** 记录一次工具调用。enabled=false 时为 no-op。 */
	recordCall(toolName: string, args: Record<string, unknown>): void {
		if (!this.config.enabled) return;
		const signature = normalizeArgs(args);
		this.window.push({ toolName, signature, timestamp: Date.now() });
		// 超过窗口大小则从队首出队。windowSize 默认 10，shift 成本可忽略。
		while (this.window.length > this.config.windowSize) {
			this.window.shift();
		}
	}

	/**
	 * 检测是否陷入循环。从窗口末尾向前扫描，统计连续相同
	 * (toolName, signature) 的数量；达到 threshold 时返回告警并自动 reset。
	 * enabled=false 或窗口为空时返回 null。
	 */
	detect(): DoomLoopAlert | null {
		if (!this.config.enabled) return null;
		if (this.window.length === 0) return null;

		const last = this.window[this.window.length - 1];
		let consecutiveCount = 0;
		for (let i = this.window.length - 1; i >= 0; i--) {
			const record = this.window[i];
			if (record.toolName === last.toolName && record.signature === last.signature) {
				consecutiveCount++;
			} else {
				break;
			}
		}

		if (consecutiveCount < this.config.threshold) return null;

		const alert: DoomLoopAlert = {
			toolName: last.toolName,
			consecutiveCount,
			signature: last.signature,
			message: `检测到循环：连续 ${consecutiveCount} 次调用 ${last.toolName} 相同参数，请改变策略或停止重复操作`,
		};
		// 触发后自动 reset，避免对同一循环重复告警
		this.window = [];
		return alert;
	}

	/** 重置窗口（手动清除历史）。 */
	reset(): void {
		this.window = [];
	}

	/** 获取当前窗口状态（用于测试/调试）。返回的数组为只读视图。 */
	get state(): readonly ToolCallRecord[] {
		return this.window;
	}
}
