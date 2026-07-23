/**
 * Chinese translations for settings panel labels and descriptions.
 *
 * Keys mirror the `path` of each setting in `SETTINGS_SCHEMA`
 * (`settings-schema.ts`). Each entry has a `label` (short name) and
 * `description` (longer help text). Settings without an entry here fall
 * back to the English text from the schema at render time, so partial
 * coverage is safe — gaps surface as English, never blank.
 *
 * Translation conventions:
 *  - Proper nouns (MCP, SSH, LSP, TTSR, OpenAI, Anthropic, Git, GitHub,
 *    Kitty, etc.) stay in English.
 *  - Tool/command names (`bash`, `read`, `grep`, etc.) stay in English.
 *  - Code identifiers and config keys (`service_tier`, `LANG`, etc.)
 *    stay in English and are kept verbatim.
 *  - Setting paths like `"theme.dark"` are NOT translated — they are
 *    programmatic keys.
 *  - Tone: imperative, concise, no trailing punctuation (matches the
 *    English source style).
 */

export type SettingField = "label" | "description";

export type SettingTranslation = Partial<Record<SettingField, string>>;

export const zhSettings: Record<string, SettingTranslation> = {
	autoResume: {
		label: "自动恢复",
		description: "在当前目录自动恢复最近的会话",
	},
	"power.sleepPrevention": {
		label: "防止睡眠",
		description: "在活跃会话期间防止 macOS 进入睡眠。每个级别是累加的——它会叠加所有更低级别的标志",
	},
	"advisor.enabled": {
		label: "启用顾问",
		description: "配对一个二级模型（分配给 'advisor' 角色），它会被动评审每一轮并注入备注",
	},
	"prewalk.enabled": {
		label: "启用预演",
		description:
			"在当前活跃模型上启动，当计划提示的待办列表存在后，在第一次 edit/write 时切换到快速/廉价模型（默认是 'smol' 角色）——强模型负责规划、提交待办，并启动实现，然后交接。可用 --prewalk / --no-prewalk 按会话覆盖",
	},
	"advisor.subagents": {
		label: "子智能体顾问",
		description: "同时为派生的 task/eval 子智能体启用顾问",
	},
	"advisor.syncBacklog": {
		label: "顾问同步积压",
		description: "当顾问落后指定轮数时，暂停主智能体最多 30 秒。Off 关闭追赶延迟",
	},
	"advisor.immuneTurns": {
		label: "顾问免疫轮数",
		description: "当顾问的 concern 或 blocker 中断后，在此数量的主轮次内，后续的 concern/blocker 以非中断方式路由",
	},
	"git.enabled": {
		label: "启用 Git 集成",
		description: "在 TUI 中显示 git 分支、状态和 PR 信息，并监视仓库元数据",
	},
	"providers.maxInFlightRequests": {
		label: "最大并发请求数",
		description:
			'每个服务商 id（例如 "openai" 或 "anthropic"）的最大并发 LLM 请求数，在同一配置根下的本地 OMP 进程间共享。未列出的服务商不受限制。',
	},
	modelRoleStorage: {
		label: "模型角色存储位置",
		description: "模型选择器的角色分配保存到哪里",
	},
	"theme.dark": {
		label: "深色主题",
		description: "终端深色背景时使用的主题",
	},
	"theme.light": {
		label: "浅色主题",
		description: "终端浅色背景时使用的主题",
	},
	symbolPreset: {
		label: "符号预设",
		description: "图标和符号的字形集（Unicode、Nerd Font 或 ASCII）",
	},
	colorBlindMode: {
		label: "色盲模式",
		description: "差异比较的新增行使用蓝色而非绿色",
	},
	language: {
		label: "语言",
		description: "欢迎页、操作按钮和 tips 的界面语言。`auto` 从系统 locale 自动检测 (LANG/LC_ALL)",
	},
	"statusLine.preset": {
		label: "状态栏预设",
		description: "预置的状态栏配置",
	},
	"statusLine.separator": {
		label: "状态栏分隔符",
		description: "各段之间的分隔符样式",
	},
	"statusLine.sessionAccent": {
		label: "会话强调色",
		description: "使用会话名颜色作为编辑器边框和状态栏间隙的颜色",
	},
	"statusLine.transparent": {
		label: "透明状态栏",
		description:
			"状态栏使用终端默认背景而非主题的 `statusLineBg`。Powerline 端帽会被丢弃，因为它们需要对比填充来过渡到周围终端",
	},
	"statusLine.compactThinkingLevel": {
		label: "紧凑思考级别",
		description: "把思考级别显示为模型名上的单个图标，而不是单独的 ` · <level>` 后缀",
	},
	"tools.artifactSpillThreshold": {
		label: "产物溢出阈值 (KB)",
		description: "工具输出超过此大小时保存为产物；尾部内容保留在行内",
	},
	"tools.artifactTailBytes": {
		label: "产物尾部大小 (KB)",
		description: "输出溢出到产物时保留在行内的尾部内容量",
	},
	"tools.artifactHeadBytes": {
		label: "产物头部大小 (KB)",
		description: "输出溢出到产物时与尾部一起保留在行内的头部内容量（中部省略）。0 表示禁用——只保留尾部",
	},
	"tools.outputMaxColumns": {
		label: "输出列数上限",
		description:
			"流式工具输出（bash、python、js eval）和 `read` 的每行字节上限。超过此宽度的行会被省略号截断；到下一个换行符之前的剩余字节会被丢弃。0 表示禁用",
	},
	"tools.artifactTailLines": {
		label: "产物尾部行数",
		description: "输出溢出到产物时保留在行内的尾部内容最大行数",
	},
	"statusLine.showHookStatus": {
		label: "显示 Hook 状态",
		description: "在状态栏下方显示 hook 状态消息",
	},
	"terminal.showImages": {
		label: "显示内联图片",
		description: "在终端中内联渲染图片",
	},
	"images.autoResize": {
		label: "自动缩放图片",
		description: "把大图缩放到最大 2000x2000，以提升模型兼容性",
	},
	"images.blockImages": {
		label: "屏蔽图片",
		description: "阻止图片被发送给 LLM 服务商",
	},
	"images.describeForTextModels": {
		label: "为文本模型描述图片",
		description: "当图片附带给不支持视觉的模型时，将其保存到 local:// 并注入来自视觉模型的描述，而不是丢弃它",
	},
	"terminal.showProgress": {
		label: "原生终端进度",
		description: "在智能体或上下文维护运行期间发出 OSC 9;4 不定进度信号",
	},
	"tui.textSizing": {
		label: "大号标题 (Kitty)",
		description:
			"使用 Kitty 的 OSC 66 文本缩放协议把 Markdown H1 标题渲染为 2x 大小。仅在 Kitty 终端生效；其他终端忽略。默认关闭",
	},
	"tui.renderMermaid": {
		label: "渲染 Mermaid 图",
		description: "把 Mermaid 围栏代码块渲染为 ASCII 图",
	},
	"tui.hyperlinks": {
		label: "终端超链接",
		description:
			"把路径和 URL 包裹在 OSC 8 超链接中，支持终端原生点击打开（auto：检测支持；off：从不；always：无条件）",
	},
	"tui.tight": {
		label: "紧凑布局",
		description: "移除终端输出左右两侧各 1 字符的水平内边距",
	},
	"tui.scrollbackRebuild": {
		label: "重写滚动缓冲",
		description:
			"当某个块的最终形态取代其实时预览时，擦除并重放终端滚动缓冲。关闭（默认）时，旧的预览副本保留在历史中，最终内容追加在下方",
	},
	"display.shimmer": {
		label: "微光动画",
		description: "工作/加载消息的动画样式",
	},
	"display.smoothStreaming": {
		label: "平滑流式",
		description: "在数据块到达时平滑地显露智能体文本和流式工具输入",
	},
	"display.showTokenUsage": {
		label: "显示 token 用量",
		description: "在智能体消息上显示每轮的 token 用量",
	},
	"display.cacheMissMarker": {
		label: "缓存未命中标记",
		description: "在丢失（未命中）prompt 缓存的智能体轮次上方显示分隔线",
	},
	"display.collapseCompacted": {
		label: "折叠压缩历史",
		description: "在实时转录区中把压缩前的历史折叠到摘要分隔线后；禁用以保持完整转录行内显示，每个压缩点都有分隔线",
	},
	showHardwareCursor: {
		label: "显示硬件光标",
		description: "显示终端光标以支持输入法",
	},
	"tui.imeSafeCursor": {
		label: "输入法安全提示布局",
		description: "把提示的底边框移到单独一行，使 macOS 输入法预编辑无法移动它",
	},
	defaultThinkingLevel: {
		label: "思考级别",
		description: "支持思考的模型的推理深度",
	},
	hideThinkingBlock: {
		label: "隐藏思考块",
		description: "在智能体响应中隐藏思考块",
	},
	proseOnlyThinking: {
		label: "仅文字思考",
		description: "从思考摘要中省略代码块并用省略号替代",
	},
	omitThinking: {
		label: "省略思考摘要",
		description: "指示上游服务商在响应中完全省略思考摘要（在支持的地方）",
	},
	"model.loopGuard.enabled": {
		label: "循环守卫",
		description: "为模型推理和正文启用自动流循环检测",
	},
	"model.loopGuard.checkAssistantContent": {
		label: "循环守卫扫描正文",
		description: "把循环守卫应用到智能体正文消息以及思考日志",
	},
	"model.loopGuard.toolCallReminder": {
		label: "循环守卫工具调用提醒",
		description:
			"当 Gemini 推理流连续发出许多规划标题而未调用工具时，中断它并注入提醒要求发起工具调用（需要循环守卫）",
	},
	"model.toolCallLoopGuard.enabled": {
		label: "工具调用循环守卫",
		description: "检测跨轮次的连续相同工具调用并注入纠正性引导",
	},
	"model.toolCallLoopGuard.threshold": {
		label: "工具调用循环阈值",
		description: "注入纠正性引导前所需的连续相同工具调用次数",
	},
	"model.toolCallLoopGuard.exemptTools": {
		label: "工具调用循环豁免工具",
		description: "可连续重复而不会触发跨轮次循环守卫的工具名",
	},
	inlineToolDescriptors: {
		label: "内联工具描述符",
		description:
			"在系统提示中渲染完整工具描述符，并从服务商工具 schema 中剥离顶层/嵌套描述，使描述符文本只发送一次。Auto 对 Gemini 模型启用，其他禁用",
	},
	includeModelInPrompt: {
		label: "在提示中包含模型",
		description: "在系统提示中暴露当前模型标识符，让智能体知道自己是哪个模型",
	},
	includeWorkspaceTree: {
		label: "包含工作区树",
		description: "在系统提示中渲染工作区目录树。警告：文件被修改时，这会破坏跨会话的 prompt 缓存",
	},
	includeRepoMap: {
		label: "包含仓库地图",
		description:
			"在系统提示中渲染排序后的符号索引（工作树中按符号数和跨文件引用数打分的顶层定义）。补充工作区树；同样的缓存警告适用",
	},
	personality: {
		label: "个性",
		description: "渲染到系统提示个性块的沟通风格",
	},
	temperature: {
		label: "温度",
		description: "采样温度（0 = 确定性，1 = 创造性，-1 = 服务商默认）",
	},
	topP: {
		label: "Top P",
		description: "核采样截断（0-1，-1 = 服务商默认）",
	},
	topK: {
		label: "Top K",
		description: "从 top-K token 中采样（-1 = 服务商默认）",
	},
	minP: {
		label: "Min P",
		description: "最小概率阈值（0-1，-1 = 服务商默认）",
	},
	presencePenalty: {
		label: "存在惩罚",
		description: "引入已存在 token 的惩罚（-1 = 服务商默认）",
	},
	repetitionPenalty: {
		label: "重复惩罚",
		description: "重复 token 的惩罚（-1 = 服务商默认）",
	},
	textVerbosity: {
		label: "文本冗长度",
		description: "OpenAI Responses 和 Codex 的响应冗长度（low、medium 或 high）",
	},
	"tier.openai": {
		label: "服务层级 — OpenAI",
		description:
			"OpenAI / OpenAI-Codex 请求以及经 OpenRouter 路由的 OpenAI 系列模型的处理层级（none = 省略）。作为 `service_tier` 发送",
	},
	"tier.anthropic": {
		label: "服务层级 — Anthropic",
	},
	"tier.google": {
		label: "服务层级 — Google",
		description:
			"Gemini（Google AI Studio + Vertex）请求以及经 OpenRouter 路由的 Google 系列模型的处理层级（none = 省略）。作为顶层 `serviceTier` 字段发送",
	},
	"tier.subagent": {
		label: "服务层级 — 子智能体",
		description:
			"派生的 task/eval 子智能体的服务层级。Inherit = 跟随主智能体实时的每家族层级（追踪 /fast）；选择一个值以应用到子智能体模型所属的家族",
	},
	"tier.advisor": {
		label: "服务层级 — 顾问",
		description:
			"顾问模型的服务层级。None = 标准处理；Inherit = 跟随主智能体实时的每家族层级；选择一个值以应用到顾问模型所属的家族",
	},
	"retry.maxRetries": {
		label: "重试次数",
		description: "API 错误时的最大重试次数",
	},
	"retry.maxDelayMs": {
		label: "最大重试延迟",
		description:
			"重试之间的最大等待毫秒数。当服务商要求等待更久且无凭据或模型回退成功时，请求快速失败而非睡眠（例如 3 小时的 Anthropic 限速窗口）",
	},
	"retry.modelFallback": {
		label: "重试模型回退",
		description: "允许重试恢复切换到配置的回退模型",
	},
	"retry.fallbackChains": {
		label: "重试回退链",
	},
	"retry.fallbackRevertPolicy": {
		label: "回退还原策略",
		description: "回退后何时返回主模型",
	},
	"providers.anthropic.serverSideFallback": {
		label: "Anthropic 服务端回退 (Fable 5)",
		description:
			"当 Claude Fable 5 / Mythos 5 请求被 Anthropic 安全分类器拦截时，在服务端重试于 Claude Opus 4.8（Anthropic `server-side-fallback-2026-06-01` beta）。需手动开启——关闭时所有请求保留回退前的行为",
	},
	steeringMode: {
		label: "转向模式",
		description: "智能体工作时如何处理排队的消息",
	},
	followUpMode: {
		label: "后续消息模式",
		description: "一轮结束后如何排空后续消息",
	},
	interruptMode: {
		label: "中断模式",
		description: "转向消息何时中断工具执行",
	},
	"loop.mode": {
		label: "循环模式",
		description: "在重新提交提示之前，/loop 迭代之间发生什么",
	},
	doubleEscapeAction: {
		label: "双击 Esc 动作",
		description: "在空编辑器中按两次 Esc 时的动作",
	},
	treeFilterMode: {
		label: "会话树过滤",
		description: "打开会话树时的默认过滤模式",
	},
	autocompleteMaxVisible: {
		label: "自动补全条目",
		description: "自动补全下拉菜单中可见的最大条目数（3-20）",
	},
	emojiAutocomplete: {
		label: "Emoji 自动补全",
		description: "从 `:name:` 短码建议 emoji，并扩展像 `:D` 或 `:-)` 这样的文本表情",
	},
	"paste.largeMenuThreshold": {
		label: "大粘贴菜单",
		description:
			"当粘贴达到这么多行时，提供菜单把它包成代码块、包成 XML 标签或保存到文件。0 禁用菜单（大粘贴仍会折叠为 [Paste] 标记）",
	},
	"startup.quiet": {
		label: "安静启动",
		description: "跳过欢迎页和启动状态消息",
	},
	"startup.showSplash": {
		label: "显示启动动画",
		description: "在正常交互式启动时显示完整的动画设置 splash，不重新运行 setup。安静启动仍会抑制它",
	},
	"startup.setupWizard": {
		label: "设置向导",
		description: "每个 setup 版本只显示一次新增的引导步骤",
	},
	"startup.checkUpdate": {
		label: "检查更新",
		description: "启动时检查 omp 更新",
	},
	"marketplace.autoUpdate": {
		label: "插件市场自动更新",
		description: "启动时检查插件更新",
	},
	collapseChangelog: {
		label: "折叠更新日志",
		description: "更新后显示精简的更新日志",
	},
	"magicKeywords.enabled": {
		label: "魔法关键词",
		description: "为独立的 ultrathinks、orchestrate 和 workflowz 关键词启用隐藏提示",
	},
	"magicKeywords.ultrathink": {
		label: "Ultrathink 关键词",
		description: "让独立的 ultrathink 请求最大自动思考并追加其隐藏提示",
	},
	"magicKeywords.orchestrate": {
		label: "Orchestrate 关键词",
		description: "让独立的 orchestrate 追加其隐藏的多智能体编排提示",
	},
	"magicKeywords.workflow": {
		label: "Workflow 关键词",
		description: "让独立的 workflowz 追加其隐藏的 eval 工作流提示",
	},
	"completion.notify": {
		label: "完成通知",
		description: "智能体完成一轮时通知",
	},
	"ask.timeout": {
		label: "询问超时",
		description: "在此秒数后自动选择推荐的询问选项（0 禁用）",
	},
	"ask.notify": {
		label: "询问通知",
		description: "ask 工具等待输入时通知",
	},
	"recap.enabled": {
		label: "空闲回顾",
		description: "终端空闲后生成一个简短的 LLM 回顾说明当前进度",
	},
	"recap.idleSeconds": {
		label: "空闲回顾延迟",
		description: "显示回顾前等待的空闲秒数",
	},
	"collab.relayUrl": {
		label: "中继 URL",
		description: "/collab 使用的中继 (wss://host[:port])",
	},
	"collab.webUrl": {
		label: "Web UI URL",
		description: "/collab 链接使用的浏览器 UI；空则从 collab.relayUrl 派生；显式 http:// 仅限 localhost",
	},
	"collab.displayName": {
		label: "显示名",
		description: "向其他协作者显示的名字（默认：OS 用户名）",
	},
	"share.serverUrl": {
		label: "分享服务器",
		description: "/share 使用的分享查看器/上传基址（加密 blob 上传 + 查看器；链接为 <base>/<id>#<key>）",
	},
	"share.store": {
		label: "分享存储",
		description: "/share 把加密会话 blob 上传到哪里",
	},
	"share.redactSecrets": {
		label: "分享密钥脱敏",
		description: "上传前对 /share 快照运行密钥混淆器（使用 secrets.* 配置）",
	},
	"stt.enabled": {
		label: "语音转文字",
		description: "通过麦克风启用语音转文字输入",
	},
	"stt.modelName": {
		label: "语音模型",
		description:
			"本地设备端语音模型。Parakeet TDT v3 (sherpa-onnx) 是 SoTA 默认；Whisper base/small/large-v3-turbo 级别 (transformers.js) 用大小换取多语言覆盖。首次使用时下载",
	},
	"stt.submitTrigger": {
		label: "语音转文字提交触发",
		description: "选择语音听写何时自动提交：从不、释放（2+ 词）、释放并要求完整句子、当我说 Submit 时",
	},
	"contextPromotion.enabled": {
		label: "自动提升上下文",
		description: "上下文溢出时提升到更大上下文模型，而非压缩",
	},
	"compaction.enabled": {
		label: "自动压缩",
		description: "上下文过大时自动压缩",
	},
	"compaction.midTurnEnabled": {
		label: "中途压缩",
		description: "在下一次服务商请求前的安全中途工具循环边界检查阈值",
	},
	"compaction.strategy": {
		label: "压缩策略",
		description:
			"选择就地上下文完整维护、自动交接、外科手术式 shake（丢弃沉重内容）、snapcompact（把历史归档为密集图像）或禁用自动维护（off）",
	},
	"compaction.thresholdPercent": {
		label: "压缩阈值",
		description: "上下文维护的百分比阈值；设为 Default 使用传统的基于预留的行为",
	},
	"compaction.thresholdTokens": {
		label: "压缩 token 上限",
		description: "上下文维护的固定 token 上限；设置后覆盖百分比",
	},
	"compaction.handoffSaveToDisk": {
		label: "保存交接文档",
		description: "为自动交接流程把生成的交接文档保存为 markdown 文件",
	},
	"compaction.remoteEnabled": {
		label: "远程压缩",
		description: "可用时使用远程压缩端点而非本地摘要",
	},
	"compaction.remoteStreamingV2Enabled": {
		label: "远程压缩 V2",
		description: "对兼容的远程压缩模型使用 Responses 流式压缩",
	},
	"compaction.idleEnabled": {
		label: "空闲压缩",
		description: "空闲时若 token 数超过阈值则压缩上下文",
	},
	"compaction.idleThresholdTokens": {
		label: "空闲压缩阈值",
		description: "触发空闲压缩的 token 数",
	},
	"compaction.idleTimeoutSeconds": {
		label: "空闲压缩延迟",
		description: "压缩前等待的空闲秒数",
	},
	"compaction.supersedeReads": {
		label: "取代过期读取",
		description: "再次读取同一文件时修剪较旧的读取结果（缓存感知，每轮运行）",
	},
	"compaction.dropUseless": {
		label: "省略无事件结果",
		description: "标记为上下文无用（无匹配、超时等待）的工具结果在消费后修剪（缓存感知）",
	},
	"snapcompact.systemPrompt": {
		label: "Snapcompact 系统提示",
		description:
			"实验性：把选定的系统提示文本渲染为密集 PNG 图像并附加到第一条用户消息（仅视觉模型）。节省 token；丢失已成像文本的 prompt 缓存",
	},
	"snapcompact.toolResults": {
		label: "Snapcompact 工具结果",
		description: "实验性：把大型历史工具结果渲染为密集 PNG 图像而非文本（仅视觉模型）。节省累积的读取/搜索输出 token",
	},
	"tools.format": {
		label: "工具调用模式",
		description:
			"控制工具如何暴露给模型。Auto 使用服务商原生工具调用，除非所选模型被标记为不支持，然后回退到 GLM 自有方言。Native 强制服务商原生工具；其他值强制指定的自有方言。在会话启动时应用",
	},
	"snapcompact.shape": {
		label: "Snapcompact 形状",
		description: "snapcompact 打印文本的帧形状（压缩归档和内联成像）。Auto 选择针对当前模型调优的形状",
	},
	"branchSummary.enabled": {
		label: "分支摘要",
		description: "离开分支时提示生成摘要",
	},
	"memory.backend": {
		label: "记忆后端",
		description: "Off、本地摘要流水线、Mnemopi SQLite 或 Hindsight 远程记忆",
	},
	"autolearn.enabled": {
		label: "自动学习（实验性）",
		description: "智能体停止后，提示它把经验记录到记忆并创建/增强独立的托管技能",
	},
	"autolearn.autoContinue": {
		label: "停止时自动捕获",
		description: "开启时，停止时自动运行一次私有捕获轮次（使用额外 token）。关闭时，仅保留常驻的自动学习指导",
	},
	"mnemopi.dbPath": {
		label: "Mnemopi 数据库路径",
		description: "可选的 SQLite 数据库路径。默认为智能体记忆目录",
	},
	"mnemopi.bank": {
		label: "Mnemopi 银行",
		description: "可选的共享银行基础名。按项目模式从它派生项目本地银行",
	},
	"mnemopi.scoping": {
		label: "Mnemopi 作用域",
		description:
			"global = 一个共享银行；per-project = 每个 cwd 独立银行；per-project-tagged = 项目本地写入 + 全局召回可见性",
	},
	"mnemopi.embeddingVariant": {
		label: "嵌入变体",
		description:
			"本地嵌入模型家族。en = 较强的英文模型；multilingual = 跨语言模型。更改此项会在下次启动时重建现有记忆嵌入",
	},
	"mnemopi.autoRecall": {
		label: "Mnemopi 自动召回",
		description: "在每个会话的第一轮召回本地记忆",
	},
	"mnemopi.autoRetain": {
		label: "Mnemopi 自动保留",
		description: "把已完成的对话轮次保留到本地 Mnemopi 记忆",
	},
	"mnemopi.polyphonicRecall": {
		label: "Mnemopi 多相召回",
		description: "启用 4 路召回（向量、图、事实、时序）并用互逆排名融合",
	},
	"mnemopi.enhancedRecall": {
		label: "Mnemopi 增强召回",
		description: "为重复和相似召回查询启用分层查询结果缓存",
	},
	"mnemopi.proactiveLinking": {
		label: "Mnemopi 主动链接",
		description: "存储新记忆时把它们摄入情节图，链接到相关实体和记忆",
	},
	"mnemopi.noEmbeddings": {
		label: "Mnemopi 禁用嵌入",
		description: "强制确定性仅 FTS 召回而非向量嵌入",
	},
	"mnemopi.embeddingModel": {
		label: "Mnemopi 嵌入模型",
		description: "高级：覆盖变体的显式嵌入模型 ID。留空以使用 mnemopi.embeddingVariant",
	},
	"mnemopi.embeddingApiUrl": {
		label: "Mnemopi 嵌入 API URL",
		description: "传递给 Mnemopi 的可选 OpenAI 兼容嵌入端点",
	},
	"mnemopi.embeddingApiKey": {
		label: "Mnemopi 嵌入 API Key",
		description: "传递给 Mnemopi 的可选嵌入 API key",
	},
	"mnemopi.llmMode": {
		label: "Mnemopi LLM 模式",
		description: "不使用 LLM、使用在线微型模型（/models 中的 TINY 角色，否则 @smol）或远程 OpenAI 兼容端点",
	},
	"mnemopi.llmBaseUrl": {
		label: "Mnemopi LLM Base URL",
		description: "Mnemopi 远程模式的可选 OpenAI 兼容 LLM 端点",
	},
	"mnemopi.llmApiKey": {
		label: "Mnemopi LLM API Key",
		description: "Mnemopi 远程模式的可选 LLM API key",
	},
	"mnemopi.llmModel": {
		label: "Mnemopi LLM 模型",
		description: "Mnemopi 远程模式的可选 LLM 模型名",
	},
	"hindsight.apiUrl": {
		label: "Hindsight API URL",
		description: "Hindsight 服务器 URL（云端或自托管）",
	},
	"hindsight.bankId": {
		label: "Hindsight 银行 ID",
		description: "记忆银行标识符（默认：项目名）",
	},
	"hindsight.scoping": {
		label: "Hindsight 作用域",
		description:
			"global = 一个共享银行；per-project = 每个 cwd 独立银行；per-project-tagged = 带项目标签的共享银行，使全局 + 项目记忆在召回时合并",
	},
	"hindsight.autoRecall": {
		label: "Hindsight 自动召回",
		description: "在每个会话的第一轮召回记忆",
	},
	"hindsight.autoRetain": {
		label: "Hindsight 自动保留",
		description: "每 N 轮及会话边界保留转录",
	},
	"hindsight.retainMode": {
		label: "Hindsight 保留模式",
		description: "full-session = 每会话 upsert 一个文档，last-turn = 分块",
	},
	"hindsight.mentalModelsEnabled": {
		label: "Hindsight 心智模型",
		description:
			"启动时把策划的反思摘要（心智模型）读入开发者指令。加载银行上现有的模型——不写入。配合 hindsight.mentalModelAutoSeed 也可自动创建内置种子集",
	},
	"hindsight.mentalModelAutoSeed": {
		label: "Hindsight 心智模型自动种子",
		description: "会话开始时，创建银行上尚不存在的任何内置心智模型（项目约定、项目决策、用户偏好）",
	},
	"ttsr.enabled": {
		label: "TTSR",
		description: "输出匹配规则模式时中途中断智能体流（时间旅行流规则）",
	},
	"ttsr.contextMode": {
		label: "TTSR 上下文模式",
		description: "TTSR 触发时如何处理部分输出",
	},
	"ttsr.interruptMode": {
		label: "TTSR 中断模式",
		description: "何时中途中断 vs 完成后注入警告",
	},
	"ttsr.repeatMode": {
		label: "TTSR 重复模式",
		description: "规则如何重复：每会话一次或在消息间隔后",
	},
	"ttsr.repeatGap": {
		label: "TTSR 重复间隔",
		description: "规则再次触发前的消息数",
	},
	"ttsr.builtinRules": {
		label: "内置规则",
		description: "加载随智能体发布的默认规则（用 ttsr.disabledRules 单独覆盖）",
	},
	"ttsr.disabledRules": {
		label: "禁用规则",
		description: "完全忽略的规则名（适用于打包的默认规则和自定义规则）",
	},
	"edit.mode": {
		label: "编辑模式",
		description: "选择编辑工具变体（replace、patch、hashline 或 apply_patch）",
	},
	"edit.fuzzyMatch": {
		label: "模糊匹配",
		description: "接受空白差异的高置信度模糊匹配",
	},
	"edit.fuzzyThreshold": {
		label: "模糊匹配阈值",
		description: "接受模糊匹配的相似度阈值（0-1）",
	},
	"edit.streamingAbort": {
		label: "预览失败时中止",
		description: "补丁预览失败时中止流式编辑工具调用",
	},
	"edit.blockAutoGenerated": {
		label: "屏蔽自动生成文件",
		description: "阻止编辑看起来是自动生成的文件（protoc、sqlc、swagger 等）",
	},
	"edit.enforceSeenLines": {
		label: "强制已见行守卫",
		description: "拒绝基于之前读取/搜索未完整显示的行所做的编辑",
	},
	readLineNumbers: {
		label: "行号",
		description: "默认在读取工具输出前加行号",
	},
	"read.defaultLimit": {
		label: "默认读取上限",
		description: "智能体调用 read 不带 limit 时返回的默认行数",
	},
	"read.summarize.enabled": {
		label: "读取摘要",
		description: "当 read 在不带显式选择器的情况下被调用时返回结构化代码摘要",
	},
	"read.summarize.prose": {
		label: "正文摘要",
		description: "为 Markdown 和纯文本读取返回结构化摘要",
	},
	"read.summarize.minBodyLines": {
		label: "读取摘要正文行数",
		description: "读取摘要折叠多行正文或字面量前的最小长度",
	},
	"read.summarize.minCommentLines": {
		label: "读取摘要注释行数",
		description: "读取摘要折叠多行块注释前的最小长度",
	},
	"read.summarize.minTotalLines": {
		label: "读取摘要最小文件长度",
		description: "总行数少于此的文件会原文读取而非结构化摘要",
	},
	"read.summarize.unfoldUntil": {
		label: "读取摘要展开目标",
		description: "BFS 展开可省略跨度直到摘要至少有这么多可见行。0 只保留最外层省略",
	},
	"read.summarize.unfoldLimit": {
		label: "读取摘要展开上限",
		description: "BFS 展开时摘要大小的硬上限。会超过此值的展开被跳过（该跨度保持折叠），继续展开剩余跨度",
	},
	"read.toolResultPreview": {
		label: "内联读取预览",
		description: "在转录区中内联渲染读取工具结果而非摘要行",
	},
	"lsp.enabled": {
		label: "LSP",
		description: "为代码智能启用 lsp 工具（定义、引用、诊断、重命名）",
	},
	"lsp.lazy": {
		label: "懒启动 LSP",
		description: "首次使用（lsp 工具或编辑匹配的文件类型）时启动语言服务器，而非会话启动时",
	},
	"lsp.formatOnWrite": {
		label: "写入时格式化",
		description: "写入代码文件后使用 LSP 自动格式化",
	},
	"lsp.diagnosticsOnWrite": {
		label: "写入时诊断",
		description: "写入代码文件后返回 LSP 诊断",
	},
	"lsp.diagnosticsOnEdit": {
		label: "编辑时诊断",
		description: "编辑代码文件后返回 LSP 诊断",
	},
	"lsp.diagnosticsDeduplicate": {
		label: "去重诊断",
		description: "抑制编辑后已为文件显示的 LSP 诊断；仅显示新增或变化的",
	},
	"bash.enabled": {
		label: "Bash",
		description: "启用 bash 工具执行 shell 命令",
	},
	"bash.astSecurity": {
		label: "Bash AST 安全",
		description:
			"使用 @nexus-agent/bash-ast AST 分析作为主要审批信号；解析失败或异常时回退到 CRITICAL_BASH_PATTERNS 正则",
	},
	"bash.autoBackground.enabled": {
		label: "Bash 自动后台",
		description: "自动把长时间运行的 bash 命令放到后台并稍后交付结果",
	},
	"bashInterceptor.enabled": {
		label: "Bash 拦截器",
		description: "阻止有专用工具的 shell 命令",
	},
	"shellMinimizer.enabled": {
		label: "Shell 精简器",
		description: "把 verbose shell 输出（git、npm、cargo 等）压缩后再返回给智能体",
	},
	"shellMinimizer.sourceOutlineLevel": {
		label: "Shell 精简器源码大纲",
		description: "cat/read 源文件时的源码大纲模式：default 或 aggressive",
	},
	"sandbox.enabled": {
		label: "启用 OS 沙箱",
		description:
			"对 bash 工具子进程应用内核强制的文件系统沙箱（Linux 上 Landlock、macOS 上 Seatbelt、Windows 上 ISO FS 回退）",
	},
	"sandbox.profile": {
		label: "沙箱配置",
		description:
			"内置配置（workspace/devbox/read-only/strict）、off（无沙箱）或 custom（在 ~/.nexus/sandbox.toml 中定义）",
	},
	"sandbox.violationPolicy": {
		label: "违规策略",
		description: "如何处理沙箱违规：log（记录并继续）、deny（阻止操作）、warn（记录并上报用户）",
	},
	"sandbox.fallbackBehavior": {
		label: "回退行为",
		description:
			"沙箱已启用但 OS 后端不可用时（例如 Windows ISO FS 缺失）的处理方式：error（启动失败）、warn（记录警告并以无沙箱模式继续）、continue（静默以无沙箱模式继续）",
	},
	"eval.py": {
		label: "Python Eval 后端",
		description: "允许 eval 工具把 Python 单元派发给 IPython 内核",
	},
	"eval.js": {
		label: "JavaScript Eval 后端",
		description: "允许 eval 工具把 JavaScript 单元派发给进程内运行时",
	},
	"eval.rb": {
		label: "Ruby Eval 后端",
		description: "允许 eval 工具把 Ruby 单元派发给持久 Ruby 内核",
	},
	"eval.jl": {
		label: "Julia Eval 后端",
		description: "允许 eval 工具把 Julia 单元派发给持久 Julia 内核",
	},
	"python.kernelMode": {
		label: "Python 内核模式",
		description: "在 eval 调用之间保持 IPython 内核存活，还是每次重新启动",
	},
	"python.interpreter": {
		label: "Python 解释器",
		description: "可选的精确 Python 可执行文件路径。设置后跳过自动 Python 运行时发现",
	},
	"ruby.interpreter": {
		label: "Ruby 解释器",
		description: "可选的精确 Ruby 可执行文件路径。设置后跳过自动 Ruby 运行时发现",
	},
	"julia.interpreter": {
		label: "Julia 解释器",
		description: "可选的精确 Julia 可执行文件路径。设置后跳过自动 Julia 运行时发现",
	},
	"tools.approval": {
		label: "工具审批策略",
		description: "按工具的审批策略。设为 'allow' 自动批准、'prompt' 需确认、'deny' 阻止。覆盖在每种审批模式下都生效",
	},
	"tools.approvalMode": {
		label: "工具审批",
		description:
			"工具调用的默认审批行为。'总是询问' 仅自动批准只读工具。'写入' 自动批准读取和工作区写入工具。'Yolo' 自动批准所有层级；用户策略仍可能提示或阻止",
	},
	"todo.enabled": {
		label: "待办",
		description: "启用 todo 工具进行任务跟踪",
	},
	"todo.reminders": {
		label: "待办提醒",
		description: "在智能体停止前提醒它完成待办",
	},
	"todo.remindersMax": {
		label: "待办提醒上限",
		description: "放弃前的最大待办提醒次数",
	},
	"todo.eager": {
		label: "自动创建待办",
		description: "在第一条消息后多强地推动自动创建待办列表",
	},
	"glob.enabled": {
		label: "Glob",
		description: "启用 glob 工具进行基于 glob 的文件查找",
	},
	"grep.enabled": {
		label: "Grep",
		description: "启用 grep 工具进行正则内容搜索",
	},
	"grep.contextBefore": {
		label: "Grep 前置上下文",
		description: "每个 grep 匹配前的上下文行数",
	},
	"grep.contextAfter": {
		label: "Grep 后置上下文",
		description: "每个 grep 匹配后的上下文行数",
	},
	"astGrep.enabled": {
		label: "AST Grep",
		description: "启用 ast_grep 工具进行结构化 AST 搜索",
	},
	"astEdit.enabled": {
		label: "AST Edit",
		description: "启用 ast_edit 工具进行结构化 AST 重写",
	},
	"debug.enabled": {
		label: "调试",
		description: "启用 debug 工具进行基于 DAP 的调试",
	},
	"launch.enabled": {
		label: "启动",
		description: "启用 launch 工具监管共享的长时间运行项目进程",
	},
	"speechgen.enabled": {
		label: "语音生成",
		description: "启用 tts 工具进行设备端 (Kokoro) 或 xAI Grok Voice 语音文件合成",
	},
	"generate_image.enabled": {
		label: "生成图片",
		description: "启用 generate_image 工具（文生图生成与编辑）。当 tools.xdev 开启时作为 xd:// 设备暴露",
	},
	"inspect_image.enabled": {
		label: "检查图片",
		description: "启用 inspect_image 工具，把图像理解委托给支持视觉的模型",
	},
	"checkpoint.enabled": {
		label: "检查点/回退",
		description: "启用 checkpoint 和 rewind 工具进行上下文检查点",
	},
	"checkpoint.autoEnabled": {
		label: "自动文件检查点",
		description: "在 bash/edit/write 工具修改文件前自动创建文件级检查点。启用 /rewind 以恢复磁盘状态",
	},
	"checkpoint.autoInterval": {
		label: "自动检查点间隔（秒）",
		description: "自动检查点之间的最小秒数。0 = 每次工具调用前都检查点。防止快速编辑期间过多的检查点",
	},
	"checkpoint.maxSizeMb": {
		label: "检查点最大大小 (MB)",
		description: "检查点 blob 的最大总磁盘使用量。超过时，按置换策略驱逐最旧的检查点",
	},
	"checkpoint.swapPolicy": {
		label: "置换策略",
		description:
			"检查点驱逐策略：'lru'（最近最少使用）、'lru-size'（LRU + 大小上限）、'fifo'（最旧优先）、'none'（无自动驱逐）",
	},
	"fetch.enabled": {
		label: "读取 URL",
		description: "允许 read 工具获取并处理 URL",
	},
	"vault.enabled": {
		label: "Obsidian Vault",
		description:
			"启用 vault:// 内部 URL 以通过 Obsidian CLI 读取和编辑 Obsidian vault 内容。禁用时，vault:// 解析被拒绝，vault:// 条目从系统提示中省略",
	},
	"github.enabled": {
		label: "GitHub CLI",
		description:
			"启用 github 工具（基于 op 的派发，用于仓库、issue、pull request、diff、搜索、checkout、push 和 Actions 监视工作流）",
	},
	"github.cache.enabled": {
		label: "GitHub 视图缓存",
		description: "把渲染的 issue/PR 视图输出缓存到 ~/.omp/cache/github-cache.db，使重复读取免费",
	},
	"github.cache.softTtlSec": {
		label: "GitHub 缓存软 TTL",
		description: "在此窗口内，缓存的 issue/PR 视图行直接返回（秒；默认 5 分钟）",
	},
	"github.cache.hardTtlSec": {
		label: "GitHub 缓存硬 TTL",
		description: "超过软 TTL 后返回缓存行并在后台刷新；超过硬 TTL 后丢弃（秒；默认 7 天）",
	},
	"web_search.enabled": {
		label: "网页搜索",
		description: "启用 web_search 工具获取实时网页结果",
	},
	"ask.enabled": {
		label: "询问",
		description: "启用 ask 工具进行交互式用户提问",
	},
	"browser.enabled": {
		label: "浏览器",
		description: "启用 browser 工具进行脚本化 Chromium 自动化 (puppeteer)",
	},
	"browser.headless": {
		label: "无头浏览器",
		description: "以无头模式启动浏览器（禁用以显示浏览器 UI）",
	},
	"browser.cmux": {
		label: "cmux 浏览器",
		description:
			"当 cmux socket 可用时使用 cmux WKWebView 表面进行浏览器自动化。设置 PI_BROWSER_CMUX=0 或 PI_BROWSER_CMUX=1 覆盖",
	},
	"browser.screenshotDir": {
		label: "截图目录",
		description:
			"保存截图的目录。未设置时，截图存到临时文件。支持 ~。示例：~/Downloads、~/Desktop、/sdcard/Download (Android)",
	},
	"tools.intentTracing": {
		label: "意图追踪",
		description: "执行前要求智能体描述每次工具调用的意图",
	},
	"tools.abortOnFabricatedResult": {
		label: "伪造工具结果时中止",
		description: "对于带内工具调用，当模型在一轮中途开始幻觉工具结果时立即停止。禁用以让模型完成生成并丢弃幻觉续写",
	},
	"tools.maxTimeout": {
		label: "最大工具超时",
		description: "智能体可为任何工具设置的最大超时秒数（0 = 无限制）",
	},
	"async.enabled": {
		label: "异步执行",
		description: "启用异步 bash 命令和后台任务执行",
	},
	"async.pollWaitDuration": {
		label: "最大轮询时间",
		description:
			"`hub` wait 监视后台任务多长时间后返回当前状态。固定值每次等待该时长。`smart` 自适应：从 5s 开始，每次连续等待延长（最高 5m），约一分钟无等待后重置为 5s",
	},
	"irc.timeoutMs": {
		label: "IRC 超时",
		description: "hub 消息等待（和 send await:true）的默认超时（毫秒）；0 禁用超时",
	},
	"tools.xdev": {
		label: "xd:// 工具",
		description:
			"把不常用（可发现）的工具挂载到 xd:// 设备 URL 下，通过 read/write 驱动而非每次请求都发送其 schema。禁用以把每个启用的工具暴露在顶层",
	},
	"mcp.enableProjectConfig": {
		label: "MCP 项目配置",
		description: "从项目根加载 .mcp.json/mcp.json",
	},
	"mcp.notifications": {
		label: "MCP 更新注入",
		description: "把 MCP 资源更新注入到智能体对话",
	},
	"mcp.notificationDebounceMs": {
		label: "MCP 通知去抖",
		description: "在把 MCP 资源更新注入对话前的去抖窗口（毫秒）",
	},
	"plan.enabled": {
		label: "规划模式",
		description: "在执行前启用规划模式进行只读探索和规划",
	},
	"plan.defaultOnStartup": {
		label: "以规划模式启动",
		description: "每个新会话开始时自动进入规划模式",
	},
	"goal.enabled": {
		label: "目标模式",
		description: "启用每会话目标模式和隐藏的 goal 工具",
	},
	"goal.statusInFooter": {
		label: "页脚目标状态",
		description: "在状态栏中沿目标指示符显示 token 预算",
	},
	"goal.continuationModes": {
		label: "目标延续模式",
		description: "活跃目标可在轮次之间自动延续的运行模式",
	},
	"title.refreshOnReplan": {
		label: "重新规划时刷新标题",
		description: "待办初始化重新规划后刷新生成的会话标题，除非标题由用户设置",
	},
	"task.isolation.mode": {
		label: "隔离模式",
		description:
			'子智能体的隔离后端。"auto" 让原生 PAL 选择最佳可用后端（CoW 感知文件系统 → overlayfs/ProjFS → git worktree / 递归复制回退）。',
	},
	"task.isolation.merge": {
		label: "隔离合并策略",
		description: "隔离任务变更如何集成（patch 应用或分支合并）",
	},
	"task.isolation.commits": {
		label: "隔离提交风格",
		description: "嵌套仓库变更的提交消息风格（通用或 AI 生成）",
	},
	"worktree.base": {
		label: "Worktree 基础目录",
		description:
			"智能体管理的 worktree 基础目录——任务隔离副本、`github` PR checkout 和 `omp worktree` 清理都在此。未设置使用 ~/.omp/wt。必须是绝对或 ~-相对路径；相对路径被忽略。OMP_WORKTREE_DIR 环境变量覆盖此项",
	},
	"task.eager": {
		label: "偏好任务委派",
		description: "多强地推动把工作委派给子智能体",
	},
	"task.batch": {
		label: "批量任务调用",
		description:
			"把 task 工具切换为批量形态：一次调用携带 { agent, context, tasks[] }——每个条目一个子智能体（带每项隔离），且每项分配前都预置共享上下文。当 async.enabled=true 时，每次派生作为独立后台智能体运行，带正常的空闲/驻留生命周期；否则调用阻塞等待合并结果。禁用以恢复扁平的单派生 schema",
	},
	"task.maxConcurrency": {
		label: "最大并发任务",
		description: "同时运行的最大子智能体数",
	},
	"task.enableLsp": {
		label: "子智能体中的 LSP",
		description:
			"允许通过 task 工具派生的子智能体使用 lsp 工具。默认关闭以保持子智能体廉价；当 LSP 感知的委派值得额外 token 时启用",
	},
	"task.maxRecursionDepth": {
		label: "最大任务递归",
		description: "子智能体可以派生自己的子智能体的层数",
	},
	"task.maxRuntimeMs": {
		label: "最大子智能体运行时",
		description:
			"每个子智能体的硬性墙钟限制（毫秒）。0 禁用。针对逃过推理层看门狗的服务商端流挂起的深度防御；触发正常的子智能体中止，原因为 'timed out'",
	},
	"task.agentIdleTtlMs": {
		label: "智能体空闲 TTL",
		description:
			"空闲子智能体在驻留到磁盘前在内存中存活多久（毫秒）。驻留的智能体在被消息或恢复时自动复活。0 保持空闲智能体存活直到退出",
	},
	"task.softRequestBudget": {
		label: "软子智能体请求预算",
		description:
			"每个子智能体的软请求预算（每次运行的智能体请求）。超过它时注入收尾转向通知（见 task.softRequestBudgetNotice）；在 1.5x 预算时运行被强制停止，智能体必须让出其部分发现。0 禁用守卫。打包的 scout/sonic 智能体使用较低的内置预算",
	},
	"task.softRequestBudgetNotice": {
		label: "软请求预算通知",
		description: "当子智能体超过其软请求预算时注入一次转向通知，要求它在 1.5x 强制让出停止前收尾",
	},
	"task.prewalk": {
		label: "通用任务预演",
		description:
			"为打包的通用 `task` 子智能体启用预演：它在解析的模型上启动，规划并开始实现，然后在第一次 edit/write 时交接给 'smol' 角色。按智能体覆盖（task.agentPrewalk，在 /agents 中用 P 切换）和用户智能体 `prewalk` frontmatter 无论此开关如何都适用",
	},
	"tasks.todoClearDelay": {
		label: "待办自动清除延迟",
		description: "已完成或放弃的待办从待办小部件移除前的延迟",
	},
	"task.showResolvedModelBadge": {
		label: "显示已解析模型徽章",
		description: "在任务小部件状态栏中显示每个子智能体实际使用的模型 ID",
	},
	"skills.enableSkillCommands": {
		label: "技能命令",
		description: "把技能注册为 /skill:name 命令",
	},
	"commands.enableClaudeUser": {
		label: "Claude 用户命令",
		description: "从 ~/.claude/commands/ 加载命令",
	},
	"commands.enableClaudeProject": {
		label: "Claude 项目命令",
		description: "从 .claude/commands/ 加载命令",
	},
	"commands.enableOpencodeUser": {
		label: "OpenCode 用户命令",
		description: "从 ~/.config/opencode/commands/ 加载命令",
	},
	"commands.enableOpencodeProject": {
		label: "OpenCode 项目命令",
		description: "从 .opencode/commands/ 加载命令",
	},
	"secrets.enabled": {
		label: "隐藏密钥",
		description: "发送给 AI 服务商前混淆密钥",
	},
	"providers.ollama-cloud.maxConcurrency": {
		label: "Ollama Cloud 最大并发",
		description: "每个进程最大并发 Ollama Cloud 子智能体运行；0 禁用服务商特定限制",
	},
	"providers.webSearch": {
		label: "网页搜索服务商",
		description: "web_search 工具的首选服务商",
	},
	"providers.webSearchExclude": {
		label: "排除的网页搜索服务商",
		description: "web_search 永远不应使用的服务商，即使作为回退",
	},
	"providers.webSearchGeminiModel": {
		label: "Gemini web_search 模型",
		description: "Gemini Google Search grounding 的模型 ID。默认 gemini-2.5-flash",
	},
	"providers.antigravityEndpoint": {
		label: "Antigravity 端点模式",
		description: "google-antigravity 服务商的端点路由策略（chat、search、image、discovery）",
	},
	"providers.image": {
		label: "图片服务商",
		description: "图片生成的首选服务商",
	},
	"providers.fireworksTier": {
		label: "Fireworks 层级",
		description: "默认服务路径（无 service_tier）",
	},
	"providers.tts": {
		label: "文本转语音服务商",
		description: "tts 工具的后端：本地设备端神经 TTS (Kokoro-82M) 或 xAI Grok Voice",
	},
	"tts.localModel": {
		label: "本地 TTS 模型",
		description: "本地 TTS 后端使用的设备端神经 TTS 模型 (Kokoro-82M)",
	},
	"tts.localVoice": {
		label: "本地 TTS 声音",
		description: "本地 TTS 后端使用的 Kokoro 声音（美式/英式，女/男）",
	},
	"speech.enabled": {
		label: "语音朗读",
		description: "智能体输出流式时通过扬声器朗读",
	},
	"speech.mode": {
		label: "语音朗读模式",
		description: "朗读什么：all = 智能体消息 + 思考；assistant = 仅消息；yield = 仅轮次结束时的最终消息",
	},
	"speech.enhanced": {
		label: "增强语音重写",
		description:
			"合成前用 tiny/smol 模型把智能体输出重写为自然口语（描述代码、丢弃链接和 markdown）。失败时回退到机械清理",
	},
	"speech.voice": {
		label: "语音朗读声音",
		description: "朗读智能体输出时使用的 Kokoro 声音",
	},
	"providers.tinyModel": {
		label: "微型模型",
		description: "会话标题模型：默认在线（/models 中的 TINY 角色，否则 @smol），或本地设备端模型",
	},
	"providers.tinyModelDevice": {
		label: "微型模型设备",
		description: "本地微型模型（标题 + 记忆）的 ONNX 执行提供者。默认仅 CPU 推理。PI_TINY_DEVICE 环境变量覆盖此项",
	},
	"providers.tinyModelDtype": {
		label: "微型模型精度",
		description:
			"本地微型模型的 ONNX 量化/精度。默认使用每个模型自带的 dtype (q4)；低精度更快，高精度更忠实。PI_TINY_DTYPE 环境变量覆盖此项",
	},
	"providers.memoryModel": {
		label: "记忆模型",
		description:
			"用于事实提取 + 整合的 Mnemopi LLM：默认在线（/models 中的 TINY 角色，否则 smol/remote），或本地设备端模型",
	},
	"providers.autoThinkingModel": {
		label: "自动思考模型",
		description: "`auto` 思考级别的难度分类器：默认在线（/models 中的 TINY 角色，否则 smol），或本地设备端模型",
	},
	"features.unexpectedStopDetection": {
		label: "检测意外停止",
		description: "使用小模型检测智能体说将继续但未调用工具就停止的情况；自动提示它继续",
	},
	"providers.unexpectedStopModel": {
		label: "意外停止模型",
		description: "意外停止检测的分类器：默认在线（/models 中的 TINY 角色，否则 smol），或本地设备端模型",
	},
	"providers.kimiApiFormat": {
		label: "Kimi API 格式",
		description: "Kimi Code 服务商的 API 格式",
	},
	"providers.openaiWebsockets": {
		label: "OpenAI WebSockets",
		description: "OpenAI Codex 模型的 WebSocket 策略（auto 使用模型默认，on 强制，off 禁用）",
	},
	"providers.streamFirstEventTimeoutSeconds": {
		label: "流首事件超时",
		description: "等待首个模型流事件的秒数；-1 使用服务商/环境默认，0 禁用看门狗",
	},
	"providers.streamIdleTimeoutSeconds": {
		label: "流空闲超时",
		description: "模型流在事件之间可保持静默的秒数；-1 使用服务商/环境默认，0 禁用看门狗",
	},
	"providers.openrouterVariant": {
		label: "OpenRouter 路由",
		description: "附加到 OpenRouter 模型 ID 的默认路由变体后缀（选择器已命名变体时被覆盖）",
	},
	"providers.fetch": {
		label: "Fetch 服务商",
		description: "fetch/read URL 工具的读取器后端优先级",
	},
	"codexResets.autoRedeem": {
		label: "Codex 自动兑换已保存重置",
		description:
			"当一轮被活跃账户的 Codex 周限额阻止且无其他账户可用时，运行保守的已保存重置检查。unset 在花费第一个合格重置前询问，yes 不提示地花费合格重置，no 完全禁用检查。需要启用重试",
	},
	"codexResets.minBlockedMinutes": {
		label: "Codex 自动兑换最小阻止",
		description: "仅当自然周重置距现在至少这么多分钟时才自动兑换（不要为了省短期等待花费 ~30 天的积分）",
	},
	"codexResets.keepCredits": {
		label: "Codex 自动兑换储备",
		description: "低于这么多已保存重置时永不自动花费（0 = 最后一个积分可能被自动花费）",
	},
	"provider.appendOnlyContext": {
		label: "只追加上下文",
		description:
			"缓存系统提示 + 工具规范并保留只追加消息日志，使服务商前缀缓存（DeepSeek、Xiaomi/SGLang、Anthropic）以最大速率命中。Auto 对已知前缀缓存服务商启用",
	},
	"exa.enableSearch": {
		label: "Exa 搜索",
		description: "启用 Exa 基础搜索、深度搜索、代码搜索和爬取工具",
	},
	"exa.enabled": {
		label: "Exa",
		description: "所有 Exa 搜索工具的总开关",
	},
	"exa.searchDelayMs": {
		label: "Exa 搜索延迟",
		description: "Exa 网页搜索请求之间的最小延迟（毫秒）；设 0 禁用节奏",
	},
	"exa.enableResearcher": {
		label: "Exa Researcher",
		description: "启用 Exa researcher 工具进行 AI 驱动的深度研究",
	},
	"exa.enableWebsets": {
		label: "Exa Websets",
		description: "启用 Exa webset 管理和富化工具",
	},
	"searxng.endpoint": {
		label: "SearXNG 端点",
		description: "用于网页搜索的自托管 SearXNG 实例的基址 URL",
	},
	"dev.autoqa": {
		label: "自动 QA",
		description: "为所有智能体启用自动化工具问题报告 (report_tool_issue)",
	},
	"dev.autoqaPush.endpoint": {
		label: "自动 QA 推送端点",
		description: "接收 Auto QA JSON 报告的完整 URL（默认 https://qa.nexus.agent/v1/grievances）",
	},
};
