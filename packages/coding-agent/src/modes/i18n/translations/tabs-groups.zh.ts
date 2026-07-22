/**
 * Chinese translations for settings panel tab labels and group headings.
 *
 * Keys mirror `TAB_METADATA` (tab IDs) and `TAB_GROUPS` (group strings)
 * in `settings-schema.ts`. Anything missing here falls back to the
 * English source string at render time, so partial translations are safe.
 */

/** Tab ID → Chinese label. Mirrors `TAB_METADATA[tab].label`. */
export const zhTabs: Record<string, string> = {
	appearance: "外观",
	model: "模型",
	interaction: "交互",
	context: "上下文",
	memory: "记忆",
	files: "文件",
	shell: "Shell",
	tools: "工具",
	tasks: "任务",
	providers: "服务商",
	// `plugins` is added by the settings selector itself (not in SETTINGS_SCHEMA),
	// listed here so `trTab("plugins", "Plugins")` resolves to Chinese too.
	plugins: "插件",
};

/** Tab ID → (English group name → Chinese group name). Mirrors `TAB_GROUPS`. */
export const zhGroups: Record<string, Record<string, string>> = {
	appearance: {
		Theme: "主题",
		"Status Line": "状态栏",
		Display: "显示",
		Images: "图片",
	},
	model: {
		Thinking: "思考",
		Sampling: "采样",
		Prompt: "提示词",
		"Retry & Fallback": "重试与回退",
		Advisor: "顾问",
		Prewalk: "预演",
		Vision: "视觉",
	},
	interaction: {
		Input: "输入",
		Approvals: "审批",
		Notifications: "通知",
		Speech: "语音",
		Collab: "协作",
		"Magic Keywords": "魔法关键词",
		"Startup & Updates": "启动与更新",
		"Power (macOS)": "电源 (macOS)",
		Agent: "智能体",
		Git: "Git",
	},
	context: {
		General: "通用",
		Compaction: "压缩",
		"Rules (TTSR)": "规则 (TTSR)",
		Experimental: "实验性",
	},
	memory: {
		General: "通用",
		"Auto-Learn": "自动学习",
		Mnemopi: "Mnemopi",
		Hindsight: "Hindsight",
	},
	files: {
		Editing: "编辑",
		Reading: "读取",
		"Read Summaries": "读取摘要",
		LSP: "LSP",
	},
	shell: {
		Bash: "Bash",
		Sandbox: "沙箱",
		"Eval & Runtimes": "Eval 与运行时",
	},
	tools: {
		"Available Tools": "可用工具",
		Todos: "待办",
		"Grep & Browser": "Grep 与浏览器",
		GitHub: "GitHub",
		"Output Limits": "输出限制",
		Execution: "执行",
		"Discovery & MCP": "发现与 MCP",
		Developer: "开发者",
		"File Checkpoint": "文件检查点",
	},
	tasks: {
		Modes: "模式",
		Subagents: "子智能体",
		Isolation: "隔离",
		"Commands & Skills": "命令与技能",
	},
	providers: {
		Services: "服务",
		Fireworks: "Fireworks",
		"Tiny Model": "微型模型",
		Protocol: "协议",
		Timeouts: "超时",
		Privacy: "隐私",
	},
};
