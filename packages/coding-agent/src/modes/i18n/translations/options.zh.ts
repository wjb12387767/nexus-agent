/**
 * Chinese translations for submenu options declared in `settings-schema.ts`.
 *
 * Keyed by `${settingPath}::${optionValue}` so the renderer can look up the
 * label/description for any option without touching the schema itself. The
 * schema stays English-canonical; this overlay is applied at render time by
 * `trOption`.
 *
 * Conventions:
 *  - Numeric values + units: translate the unit ("50 lines" → "50 行",
 *    "30 seconds" → "30 秒"). KB / MB / tokens / K / M stay as-is.
 *  - Proper nouns (Nerd Font, ASCII, Powerline, Unicode, OpenAI, Anthropic,
 *    Gemini, DeepSeek, Kimi, GLM, Hermes, Harmony, Qwen3, Gemma, MiniMax,
 *    APFS, btrfs, ZFS, Overlayfs, ProjFS, Antigravity, Trafilatura, Lynx,
 *    Jina, Hindsight, Mnemopi) stay in English.
 *  - Code identifiers (`auto`, `default`, `off`, `on`) used as enum values
 *    are translated in their label form only.
 */

export type OptionField = "label" | "description";

export const zhOptions: Record<string, Partial<Record<OptionField, string>>> = {
	// ═══════════════════════════════════════════════════════════════════════
	// power.sleepPrevention
	// ═══════════════════════════════════════════════════════════════════════
	"power.sleepPrevention::off": { label: "关闭" },
	"power.sleepPrevention::idle": { label: "防止空闲睡眠" },
	"power.sleepPrevention::display": { label: "防止显示器睡眠" },
	"power.sleepPrevention::system": { label: "防止系统睡眠" },

	// advisor.immuneTurns
	"advisor.immuneTurns::0": { label: "0 轮", description: "允许每个 concern/blocker 中断" },
	"advisor.immuneTurns::1": { label: "1 轮" },
	"advisor.immuneTurns::2": { label: "2 轮" },
	"advisor.immuneTurns::3": { label: "3 轮", description: "默认" },
	"advisor.immuneTurns::4": { label: "4 轮" },
	"advisor.immuneTurns::5": { label: "5 轮" },

	// modelRoleStorage
	"modelRoleStorage::global": { label: "全局" },
	"modelRoleStorage::project": { label: "按项目" },

	// symbolPreset
	"symbolPreset::unicode": { label: "Unicode", description: "标准符号（默认）" },
	"symbolPreset::nerd": { label: "Nerd Font", description: "需要 Nerd Font" },
	"symbolPreset::ascii": { label: "ASCII", description: "最大兼容性" },

	// language
	"language::auto": { label: "自动", description: "从系统区域设置检测（默认）" },
	"language::en": { label: "English", description: "英文界面" },
	"language::zh": { label: "中文", description: "简体中文界面" },

	// statusLine.preset
	"statusLine.preset::default": { label: "默认", description: "模型、路径、git、上下文、token、开销" },
	"statusLine.preset::minimal": { label: "最小", description: "仅路径和 git" },
	"statusLine.preset::compact": { label: "紧凑", description: "模型、git、开销、上下文" },
	"statusLine.preset::full": { label: "完整", description: "所有段，包括时间" },
	"statusLine.preset::nerd": { label: "Nerd", description: "最大信息量，使用 Nerd Font 图标" },
	"statusLine.preset::ascii": { label: "ASCII", description: "无特殊字符" },
	"statusLine.preset::custom": { label: "自定义", description: "用户自定义段" },

	// statusLine.separator
	"statusLine.separator::powerline": { label: "Powerline", description: "实心箭头（Nerd Font）" },
	"statusLine.separator::powerline-thin": { label: "细箭头", description: "细箭头（Nerd Font）" },
	"statusLine.separator::slash": { label: "斜杠", description: "正斜杠" },
	"statusLine.separator::pipe": { label: "竖线", description: "竖直管道符" },
	"statusLine.separator::block": { label: "方块", description: "实心方块" },
	"statusLine.separator::none": { label: "无", description: "仅空格" },
	"statusLine.separator::ascii": { label: "ASCII", description: "大于号" },

	// tools.artifactSpillThreshold
	"tools.artifactSpillThreshold::1": { label: "1 KB", description: "约 250 token" },
	"tools.artifactSpillThreshold::2.5": { label: "2.5 KB", description: "约 625 token" },
	"tools.artifactSpillThreshold::5": { label: "5 KB", description: "约 1.25K token" },
	"tools.artifactSpillThreshold::10": { label: "10 KB", description: "约 2.5K token" },
	"tools.artifactSpillThreshold::20": { label: "20 KB", description: "约 5K token" },
	"tools.artifactSpillThreshold::30": { label: "30 KB", description: "约 7.5K token" },
	"tools.artifactSpillThreshold::50": { label: "50 KB", description: "默认；约 12.5K token" },
	"tools.artifactSpillThreshold::75": { label: "75 KB", description: "约 19K token" },
	"tools.artifactSpillThreshold::100": { label: "100 KB", description: "约 25K token" },
	"tools.artifactSpillThreshold::200": { label: "200 KB", description: "约 50K token" },
	"tools.artifactSpillThreshold::500": { label: "500 KB", description: "约 125K token" },
	"tools.artifactSpillThreshold::1000": { label: "1 MB", description: "约 250K token" },

	// tools.artifactTailBytes
	"tools.artifactTailBytes::1": { label: "1 KB", description: "约 250 token" },
	"tools.artifactTailBytes::2.5": { label: "2.5 KB", description: "约 625 token" },
	"tools.artifactTailBytes::5": { label: "5 KB", description: "约 1.25K token" },
	"tools.artifactTailBytes::10": { label: "10 KB", description: "约 2.5K token" },
	"tools.artifactTailBytes::20": { label: "20 KB", description: "默认；约 5K token" },
	"tools.artifactTailBytes::50": { label: "50 KB", description: "约 12.5K token" },
	"tools.artifactTailBytes::100": { label: "100 KB", description: "约 25K token" },
	"tools.artifactTailBytes::200": { label: "200 KB", description: "约 50K token" },

	// tools.artifactHeadBytes
	"tools.artifactHeadBytes::0": { label: "0 KB", description: "禁用；仅保留尾部" },
	"tools.artifactHeadBytes::1": { label: "1 KB", description: "约 250 token" },
	"tools.artifactHeadBytes::2.5": { label: "2.5 KB", description: "约 625 token" },
	"tools.artifactHeadBytes::5": { label: "5 KB", description: "约 1.25K token" },
	"tools.artifactHeadBytes::10": { label: "10 KB", description: "约 2.5K token" },
	"tools.artifactHeadBytes::20": { label: "20 KB", description: "默认；约 5K token" },
	"tools.artifactHeadBytes::50": { label: "50 KB", description: "约 12.5K token" },
	"tools.artifactHeadBytes::100": { label: "100 KB", description: "约 25K token" },
	"tools.artifactHeadBytes::200": { label: "200 KB", description: "约 50K token" },

	// tools.outputMaxColumns
	"tools.outputMaxColumns::0": { label: "关闭", description: "无每行字节上限" },
	"tools.outputMaxColumns::256": { label: "256", description: "紧凑" },
	"tools.outputMaxColumns::512": { label: "512" },
	"tools.outputMaxColumns::768": { label: "768", description: "默认" },
	"tools.outputMaxColumns::1024": { label: "1024" },
	"tools.outputMaxColumns::2048": { label: "2048" },
	"tools.outputMaxColumns::4096": { label: "4096", description: "宽松" },

	// tools.artifactTailLines
	"tools.artifactTailLines::50": { label: "50 行", description: "约 250 token" },
	"tools.artifactTailLines::100": { label: "100 行", description: "约 500 token" },
	"tools.artifactTailLines::250": { label: "250 行", description: "约 1.25K token" },
	"tools.artifactTailLines::500": { label: "500 行", description: "默认；约 2.5K token" },
	"tools.artifactTailLines::1000": { label: "1000 行", description: "约 5K token" },
	"tools.artifactTailLines::2000": { label: "2000 行", description: "约 10K token" },
	"tools.artifactTailLines::5000": { label: "5000 行", description: "约 25K token" },

	// display.shimmer
	"display.shimmer::classic": { label: "经典", description: "柔和余弦波扫过文本" },
	"display.shimmer::kitt": { label: "KITT 扫描", description: "Knight Rider 1982 红光左右弹跳" },
	"display.shimmer::disabled": { label: "禁用", description: "无动画；静态暗色文本" },

	// inlineToolDescriptors
	"inlineToolDescriptors::auto": { label: "自动", description: "Gemini 模型自动启用，其他禁用" },
	"inlineToolDescriptors::on": { label: "开启", description: "始终在系统提示中内联描述符" },
	"inlineToolDescriptors::off": { label: "关闭", description: "仅在服务商工具 schema 中保留描述符" },

	// personality
	"personality::default": { label: "默认" },
	"personality::friendly": { label: "友好" },
	"personality::pragmatic": { label: "务实" },
	"personality::none": { label: "无", description: "完全省略 personality 段" },

	// temperature
	"temperature::-1": { label: "默认", description: "使用服务商默认" },
	"temperature::0": { label: "0", description: "确定性" },
	"temperature::0.2": { label: "0.2", description: "专注" },
	"temperature::0.5": { label: "0.5", description: "平衡" },
	"temperature::0.7": { label: "0.7", description: "创造性" },
	"temperature::1": { label: "1", description: "最大多样性" },

	// topP
	"topP::-1": { label: "默认", description: "使用服务商默认" },
	"topP::0.1": { label: "0.1", description: "非常专注" },
	"topP::0.3": { label: "0.3", description: "专注" },
	"topP::0.5": { label: "0.5", description: "平衡" },
	"topP::0.9": { label: "0.9", description: "宽泛" },
	"topP::1": { label: "1", description: "无 nucleus 过滤" },

	// topK
	"topK::-1": { label: "默认", description: "使用服务商默认" },
	"topK::1": { label: "1" },
	"topK::20": { label: "20" },
	"topK::40": { label: "40" },
	"topK::100": { label: "100" },

	// minP
	"minP::-1": { label: "默认", description: "使用服务商默认" },
	"minP::0.01": { label: "0.01" },
	"minP::0.05": { label: "0.05" },
	"minP::0.1": { label: "0.1" },

	// presencePenalty
	"presencePenalty::-1": { label: "默认", description: "使用服务商默认" },
	"presencePenalty::0": { label: "0" },
	"presencePenalty::0.5": { label: "0.5" },
	"presencePenalty::1": { label: "1" },
	"presencePenalty::2": { label: "2" },

	// repetitionPenalty
	"repetitionPenalty::-1": { label: "默认", description: "使用服务商默认" },
	"repetitionPenalty::0.8": { label: "0.8" },
	"repetitionPenalty::1": { label: "1" },
	"repetitionPenalty::1.1": { label: "1.1" },
	"repetitionPenalty::1.2": { label: "1.2" },
	"repetitionPenalty::1.5": { label: "1.5" },

	// textVerbosity
	"textVerbosity::low": { label: "低" },
	"textVerbosity::medium": { label: "中" },
	"textVerbosity::high": { label: "高" },

	// retry.maxRetries
	"retry.maxRetries::1": { label: "1 次重试" },
	"retry.maxRetries::2": { label: "2 次重试" },
	"retry.maxRetries::3": { label: "3 次重试" },
	"retry.maxRetries::5": { label: "5 次重试" },
	"retry.maxRetries::10": { label: "10 次重试" },

	// retry.fallbackRevertPolicy
	"retry.fallbackRevertPolicy::cooldown-expiry": { label: "冷却到期" },
	"retry.fallbackRevertPolicy::never": { label: "从不" },

	// loop.mode
	"loop.mode::prompt": { label: "提示词" },
	"loop.mode::compact": { label: "压缩" },
	"loop.mode::reset": { label: "重置" },

	// autocompleteMaxVisible
	"autocompleteMaxVisible::3": { label: "3 项" },
	"autocompleteMaxVisible::5": { label: "5 项" },
	"autocompleteMaxVisible::7": { label: "7 项" },
	"autocompleteMaxVisible::10": { label: "10 项" },
	"autocompleteMaxVisible::15": { label: "15 项" },
	"autocompleteMaxVisible::20": { label: "20 项" },

	// paste.largeMenuThreshold
	"paste.largeMenuThreshold::0": { label: "关闭" },
	"paste.largeMenuThreshold::100": { label: "100 行" },
	"paste.largeMenuThreshold::250": { label: "250 行" },
	"paste.largeMenuThreshold::500": { label: "500 行" },
	"paste.largeMenuThreshold::1000": { label: "1000 行" },

	// marketplace.autoUpdate
	"marketplace.autoUpdate::off": { label: "关闭" },
	"marketplace.autoUpdate::notify": { label: "通知" },
	"marketplace.autoUpdate::auto": { label: "自动" },

	// ask.timeout
	"ask.timeout::0": { label: "禁用" },
	"ask.timeout::15": { label: "15 秒" },
	"ask.timeout::30": { label: "30 秒" },
	"ask.timeout::60": { label: "60 秒" },
	"ask.timeout::120": { label: "120 秒" },

	// recap.idleSeconds
	"recap.idleSeconds::60": { label: "1 分钟" },
	"recap.idleSeconds::120": { label: "2 分钟" },
	"recap.idleSeconds::240": { label: "4 分钟" },
	"recap.idleSeconds::300": { label: "5 分钟" },
	"recap.idleSeconds::600": { label: "10 分钟" },

	// share.store
	"share.store::blob": { label: "加密 Blob" },
	"share.store::gist": { label: "GitHub Gist" },

	// compaction.strategy
	"compaction.strategy::context-full": { label: "完整上下文" },
	"compaction.strategy::handoff": { label: "交接" },
	"compaction.strategy::shake": { label: "Shake" },
	"compaction.strategy::snapcompact": { label: "Snapcompact" },
	"compaction.strategy::off": { label: "关闭" },

	// compaction.thresholdPercent
	"compaction.thresholdPercent::default": { label: "默认" },
	"compaction.thresholdPercent::10": { label: "10%" },
	"compaction.thresholdPercent::20": { label: "20%" },
	"compaction.thresholdPercent::30": { label: "30%" },
	"compaction.thresholdPercent::40": { label: "40%" },
	"compaction.thresholdPercent::50": { label: "50%" },
	"compaction.thresholdPercent::60": { label: "60%" },
	"compaction.thresholdPercent::70": { label: "70%" },
	"compaction.thresholdPercent::75": { label: "75%" },
	"compaction.thresholdPercent::80": { label: "80%" },
	"compaction.thresholdPercent::85": { label: "85%" },
	"compaction.thresholdPercent::90": { label: "90%" },
	"compaction.thresholdPercent::95": { label: "95%" },

	// compaction.thresholdTokens
	"compaction.thresholdTokens::default": { label: "默认" },
	"compaction.thresholdTokens::25000": { label: "25K token" },
	"compaction.thresholdTokens::50000": { label: "50K token" },
	"compaction.thresholdTokens::100000": { label: "100K token" },
	"compaction.thresholdTokens::150000": { label: "150K token" },
	"compaction.thresholdTokens::200000": { label: "200K token" },
	"compaction.thresholdTokens::300000": { label: "300K token" },
	"compaction.thresholdTokens::500000": { label: "500K token" },

	// compaction.idleThresholdTokens
	"compaction.idleThresholdTokens::100000": { label: "100K token" },
	"compaction.idleThresholdTokens::200000": { label: "200K token" },
	"compaction.idleThresholdTokens::300000": { label: "300K token" },
	"compaction.idleThresholdTokens::400000": { label: "400K token" },
	"compaction.idleThresholdTokens::500000": { label: "500K token" },
	"compaction.idleThresholdTokens::600000": { label: "600K token" },
	"compaction.idleThresholdTokens::700000": { label: "700K token" },
	"compaction.idleThresholdTokens::800000": { label: "800K token" },
	"compaction.idleThresholdTokens::900000": { label: "900K token" },

	// compaction.idleTimeoutSeconds
	"compaction.idleTimeoutSeconds::60": { label: "1 分钟" },
	"compaction.idleTimeoutSeconds::120": { label: "2 分钟" },
	"compaction.idleTimeoutSeconds::300": { label: "5 分钟" },
	"compaction.idleTimeoutSeconds::600": { label: "10 分钟" },
	"compaction.idleTimeoutSeconds::1800": { label: "30 分钟" },
	"compaction.idleTimeoutSeconds::3600": { label: "1 小时" },

	// snapcompact.systemPrompt
	"snapcompact.systemPrompt::none": { label: "无" },
	"snapcompact.systemPrompt::agents-md": { label: "AGENTS.md" },
	"snapcompact.systemPrompt::all": { label: "全部" },

	// tools.format
	"tools.format::auto": {
		label: "自动",
		description: "除非模型已知不支持，否则使用原生工具调用。",
	},
	"tools.format::native": { label: "原生", description: "使用服务商原生工具调用。" },
	"tools.format::glm": { label: "GLM", description: "使用 GLM 风格的带内工具调用。" },
	"tools.format::hermes": { label: "Hermes", description: "使用 Hermes 风格的带内工具调用。" },
	"tools.format::kimi": { label: "Kimi", description: "使用 Kimi 风格的带内工具调用。" },
	"tools.format::xml": { label: "XML", description: "使用通用 XML 带内工具调用。" },
	"tools.format::anthropic": { label: "Anthropic", description: "使用 Anthropic 风格的带内工具调用。" },
	"tools.format::deepseek": { label: "DeepSeek", description: "使用 DeepSeek 风格的带内工具调用。" },
	"tools.format::harmony": { label: "Harmony", description: "使用 Harmony 风格的带内工具调用。" },
	"tools.format::qwen3": { label: "Qwen3", description: "使用 Qwen3 专属方言。" },
	"tools.format::gemini": { label: "Gemini", description: "使用 Gemini 专属方言。" },
	"tools.format::gemma": { label: "Gemma", description: "使用 Gemma 专属方言。" },
	"tools.format::minimax": { label: "MiniMax", description: "使用 MiniMax 专属方言。" },

	// snapcompact.shape — proper-noun-heavy, keep labels as-is
	"snapcompact.shape::auto": {
		label: "自动",
		description: "根据当前模型选择优化过的形状，回退到其服务商家族。",
	},
	"snapcompact.shape::8x8r-bw": {
		label: "8x8 重复，黑色",
		description: "unscii 方形单元，黑色墨迹，每行打印两次，副本位于浅色高亮带。",
	},
	"snapcompact.shape::8x8r-sent": {
		label: "8x8 重复，句子色调",
		description: "重复网格，墨迹在句子边界循环切换六种色调。",
	},
	"snapcompact.shape::8x8u-bw": {
		label: "8x8，黑色",
		description: "普通 unscii 方形单元，单次打印行，黑色墨迹。",
	},
	"snapcompact.shape::8x8u-sent": {
		label: "8x8，句子色调",
		description: "普通 unscii 方形单元，句子色调墨迹。",
	},
	"snapcompact.shape::6x6u-bw": {
		label: "6x6 密集，黑色",
		description: "unscii 压缩到 6x6 —— 最密集的可读单元，帧数最少 —— 黑色墨迹。",
	},
	"snapcompact.shape::6x6u-sent": {
		label: "6x6 密集，句子色调",
		description: "最密集单元，句子色调墨迹。",
	},
	"snapcompact.shape::5x8-bw": {
		label: "5x8 旧版，黑色",
		description: "原始 X.org 5x8 字形，2576px 帧，黑色墨迹。",
	},
	"snapcompact.shape::5x8-sent": {
		label: "5x8 旧版，句子色调",
		description: "原始 snapcompact 形状（shape 表之前的会话渲染的就是这个）。",
	},
	"snapcompact.shape::6x12-dim": {
		label: "6x12，停用词暗化",
		description: "X.org 6x12 字形，黑色墨迹，功能词暗化为灰色。",
	},
	"snapcompact.shape::8x13-bw": {
		label: "8x13，黑色",
		description: "X.org 8x13 字形，黑色墨迹。",
	},
	"snapcompact.shape::8on16-bw": {
		label: "8x13 on 16px pitch，黑色",
		description: "8x13 字形位于 8x16 单元（额外行距），黑色墨迹。",
	},
	"snapcompact.shape::8on22-bw": {
		label: "8x13 on 22px pitch（前导），黑色",
		description: "8x13 字形位于 8x22 单元 —— 额外行间距避免行拥挤。OpenAI/Google 的默认值。",
	},
	"snapcompact.shape::11on16-bw": {
		label: "8x13 on 11px advance（字距），黑色",
		description: "8x13 字形位于 11x16 单元 —— 额外字间距避免字符粘连。Anthropic 的默认值。",
	},
	"snapcompact.shape::silver16-bw": {
		label: "Silver 16，CJK",
		description: "内嵌 Silver TrueType 字体，16px 网格，适用于 CJK 及其他非拉丁文本。",
	},
	"snapcompact.shape::doc-8on16-bw": {
		label: "Doc 8on16，黑色",
		description: "两栏自动换行的报纸式布局，8x13 字形，16px 间距，黑色墨迹。",
	},
	"snapcompact.shape::doc-8on16-sent": {
		label: "Doc 8on16，句子色调",
		description: "两栏文档布局，句子色调墨迹。",
	},
	"snapcompact.shape::doc-8on16-sent-dim": {
		label: "Doc 8on16，句子色调 + 停用词暗化",
		description: "两栏文档布局，句子色调墨迹，功能词暗化为灰色。",
	},

	// memory.backend
	"memory.backend::off": { label: "关闭", description: "不运行任何记忆子系统" },
	"memory.backend::local": {
		label: "本地",
		description: "本地 rollout 摘要流水线 (memory_summary.md)",
	},
	"memory.backend::hindsight": {
		label: "Hindsight",
		description: "Vectorize Hindsight 远程记忆服务",
	},
	"memory.backend::mnemopi": {
		label: "Mnemopi",
		description: "本地 SQLite recall/retain 后端，可选嵌入向量",
	},

	// mnemopi.scoping
	"mnemopi.scoping::global": {
		label: "全局",
		description: "所有项目共享一个 Mnemopi bank",
	},
	"mnemopi.scoping::per-project": {
		label: "按项目",
		description: "按 cwd 基名为每个项目建立独立的 Mnemopi bank",
	},
	"mnemopi.scoping::per-project-tagged": {
		label: "按项目（带标签）",
		description: "写入项目本地 bank，但合并项目 + 共享的 recall 结果",
	},

	// mnemopi.embeddingVariant
	"mnemopi.embeddingVariant::en": {
		label: "英文 (bge-base-en-v1.5)",
		description: "BAAI/bge-base-en-v1.5 (768d)，仅英文",
	},
	"mnemopi.embeddingVariant::multilingual": {
		label: "多语言 (multilingual-e5-large)",
		description: "intfloat/multilingual-e5-large (1024d)，跨语言召回",
	},

	// mnemopi.llmMode
	"mnemopi.llmMode::none": { label: "无", description: "禁用 Mnemopi 基于 LLM 的抽取" },
	"mnemopi.llmMode::smol": {
		label: "在线（tiny）",
		description: "使用在线 tiny 模型（/models 中的 TINY 角色，否则 @smol）",
	},
	"mnemopi.llmMode::remote": {
		label: "远程",
		description: "使用下方的 Mnemopi 远程 LLM 设置",
	},

	// hindsight.scoping
	"hindsight.scoping::global": {
		label: "全局",
		description: "一个共享 bank —— 每个项目看到的记忆相同",
	},
	"hindsight.scoping::per-project": {
		label: "按项目",
		description: "按 cwd 基名隔离 bank —— 项目之间互不可见",
	},
	"hindsight.scoping::per-project-tagged": {
		label: "按项目（带标签）",
		description: "共享 bank，保留时打上 project:<cwd> 标签。recall 同时呈现项目 + 未标记的全局记忆",
	},

	// hindsight.retainMode
	"hindsight.retainMode::full-session": {
		label: "整个会话",
		description: "每个会话 upsert 一份文档（推荐）",
	},
	"hindsight.retainMode::last-turn": {
		label: "上一轮",
		description: "按对话轮次边界切片的分块保留",
	},

	// ttsr.interruptMode
	"ttsr.interruptMode::always": {
		label: "总是",
		description: "在正文和工具流上中断",
	},
	"ttsr.interruptMode::prose-only": {
		label: "仅正文",
		description: "仅在回复/思考匹配时中断",
	},
	"ttsr.interruptMode::tool-only": {
		label: "仅工具",
		description: "仅在工具调用参数匹配时中断",
	},
	"ttsr.interruptMode::never": {
		label: "从不",
		description: "从不中断；完成后注入警告",
	},

	// ttsr.repeatGap
	"ttsr.repeatGap::5": { label: "5 条消息" },
	"ttsr.repeatGap::10": { label: "10 条消息" },
	"ttsr.repeatGap::15": { label: "15 条消息" },
	"ttsr.repeatGap::20": { label: "20 条消息" },
	"ttsr.repeatGap::30": { label: "30 条消息" },

	// edit.fuzzyThreshold
	"edit.fuzzyThreshold::0.85": { label: "0.85" },
	"edit.fuzzyThreshold::0.90": { label: "0.90" },
	"edit.fuzzyThreshold::0.95": { label: "0.95" },
	"edit.fuzzyThreshold::0.98": { label: "0.98" },

	// read.defaultLimit
	"read.defaultLimit::200": { label: "200 行" },
	"read.defaultLimit::300": { label: "300 行" },
	"read.defaultLimit::500": { label: "500 行" },
	"read.defaultLimit::1000": { label: "1000 行" },
	"read.defaultLimit::5000": { label: "5000 行" },

	// sandbox.profile
	"sandbox.profile::workspace": { label: "工作区" },
	"sandbox.profile::devbox": { label: "Devbox" },
	"sandbox.profile::read-only": { label: "只读" },
	"sandbox.profile::strict": { label: "严格" },
	"sandbox.profile::off": { label: "关闭" },
	"sandbox.profile::custom": { label: "自定义" },

	// sandbox.violationPolicy
	"sandbox.violationPolicy::log": { label: "记录" },
	"sandbox.violationPolicy::deny": { label: "拒绝" },
	"sandbox.violationPolicy::warn": { label: "警告" },

	// tools.approvalMode
	"tools.approvalMode::always-ask": {
		label: "总是询问",
		description: "自动批准只读工具；写入和 exec 工具需要确认。",
	},
	"tools.approvalMode::write": {
		label: "写入",
		description: "自动批准只读和写入工具；bash、eval、browser、task 等 exec 工具需要确认。",
	},
	"tools.approvalMode::yolo": {
		label: "Yolo",
		description: "自动批准读取、写入和 exec 工具。用户策略仍可能要求确认或拦截。",
	},

	// todo.remindersMax
	"todo.remindersMax::1": { label: "1 条提醒" },
	"todo.remindersMax::2": { label: "2 条提醒" },
	"todo.remindersMax::3": { label: "3 条提醒" },
	"todo.remindersMax::5": { label: "5 条提醒" },

	// todo.eager
	"todo.eager::default": { label: "默认", description: "由模型决定；不自动创建待办列表" },
	"todo.eager::preferred": {
		label: "首选",
		description: "在首条消息时建议创建待办列表（提醒，非强制）",
	},
	"todo.eager::always": {
		label: "总是",
		description: "在首条消息时强制创建完整待办列表",
	},

	// grep.contextBefore
	"grep.contextBefore::0": { label: "0 行" },
	"grep.contextBefore::1": { label: "1 行" },
	"grep.contextBefore::2": { label: "2 行" },
	"grep.contextBefore::3": { label: "3 行" },
	"grep.contextBefore::5": { label: "5 行" },

	// grep.contextAfter
	"grep.contextAfter::0": { label: "0 行" },
	"grep.contextAfter::1": { label: "1 行" },
	"grep.contextAfter::2": { label: "2 行" },
	"grep.contextAfter::3": { label: "3 行" },
	"grep.contextAfter::5": { label: "5 行" },
	"grep.contextAfter::10": { label: "10 行" },

	// tools.maxTimeout
	"tools.maxTimeout::0": { label: "无限制" },
	"tools.maxTimeout::30": { label: "30 秒" },
	"tools.maxTimeout::60": { label: "60 秒" },
	"tools.maxTimeout::120": { label: "120 秒" },
	"tools.maxTimeout::300": { label: "5 分钟" },
	"tools.maxTimeout::600": { label: "10 分钟" },

	// async.pollWaitDuration
	"async.pollWaitDuration::5s": { label: "5 秒" },
	"async.pollWaitDuration::10s": { label: "10 秒" },
	"async.pollWaitDuration::30s": { label: "30 秒" },
	"async.pollWaitDuration::1m": { label: "1 分钟" },
	"async.pollWaitDuration::5m": { label: "5 分钟" },
	"async.pollWaitDuration::smart": { label: "智能" },

	// irc.timeoutMs
	"irc.timeoutMs::0": { label: "禁用" },
	"irc.timeoutMs::30000": { label: "30 秒" },
	"irc.timeoutMs::60000": { label: "1 分钟" },
	"irc.timeoutMs::120000": { label: "2 分钟" },
	"irc.timeoutMs::300000": { label: "5 分钟" },

	// task.isolation.mode
	"task.isolation.mode::none": { label: "无", description: "无隔离" },
	"task.isolation.mode::auto": {
		label: "自动",
		description: "由 PAL 选择最佳可用后端",
	},
	"task.isolation.mode::apfs": {
		label: "APFS",
		description: "macOS clonefile reflink (APFS)",
	},
	"task.isolation.mode::btrfs": { label: "btrfs", description: "btrfs 子卷快照" },
	"task.isolation.mode::zfs": { label: "ZFS", description: "ZFS 快照 + 克隆" },
	"task.isolation.mode::reflink": {
		label: "Reflink",
		description: "Linux FICLONE 逐文件 reflink",
	},
	"task.isolation.mode::overlayfs": {
		label: "Overlayfs",
		description: "Linux 内核 overlay（或 fuse-overlayfs 回退）",
	},
	"task.isolation.mode::projfs": {
		label: "ProjFS",
		description: "Windows Projected File System",
	},
	"task.isolation.mode::block-clone": {
		label: "块克隆",
		description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
	},
	"task.isolation.mode::rcopy": {
		label: "递归复制",
		description: "可用时使用 git worktree，否则递归复制",
	},

	// task.isolation.merge
	"task.isolation.merge::patch": {
		label: "补丁",
		description: "合并 diff 并 git apply",
	},
	"task.isolation.merge::branch": {
		label: "分支",
		description: "每个任务一次提交，使用 --no-ff 合并",
	},

	// task.isolation.commits
	"task.isolation.commits::generic": { label: "通用", description: "静态提交信息" },
	"task.isolation.commits::ai": {
		label: "AI",
		description: "基于 diff 由 AI 生成提交信息",
	},

	// task.eager
	"task.eager::default": { label: "默认", description: "由模型决定何时委托" },
	"task.eager::preferred": {
		label: "首选",
		description: "在系统提示中加入委托指引",
	},
	"task.eager::always": {
		label: "总是",
		description: "提示指引 + 首轮委托提醒",
	},

	// task.maxConcurrency
	"task.maxConcurrency::0": { label: "无限制" },
	"task.maxConcurrency::1": { label: "1 个任务" },
	"task.maxConcurrency::2": { label: "2 个任务" },
	"task.maxConcurrency::4": { label: "4 个任务" },
	"task.maxConcurrency::8": { label: "8 个任务" },
	"task.maxConcurrency::16": { label: "16 个任务" },
	"task.maxConcurrency::32": { label: "32 个任务" },
	"task.maxConcurrency::64": { label: "64 个任务" },

	// task.maxRecursionDepth
	"task.maxRecursionDepth::-1": { label: "无限制" },
	"task.maxRecursionDepth::0": { label: "无" },
	"task.maxRecursionDepth::1": { label: "单层" },
	"task.maxRecursionDepth::2": { label: "两层" },
	"task.maxRecursionDepth::3": { label: "三层" },

	// task.maxRuntimeMs
	"task.maxRuntimeMs::0": { label: "无限制" },
	"task.maxRuntimeMs::300000": { label: "5 分钟" },
	"task.maxRuntimeMs::900000": { label: "15 分钟" },
	"task.maxRuntimeMs::1800000": { label: "30 分钟" },
	"task.maxRuntimeMs::3600000": { label: "1 小时" },

	// task.softRequestBudget
	"task.softRequestBudget::0": { label: "禁用" },
	"task.softRequestBudget::90": { label: "90 次请求" },
	"task.softRequestBudget::150": { label: "150 次请求" },
	"task.softRequestBudget::200": { label: "200 次请求" },

	// tasks.todoClearDelay
	"tasks.todoClearDelay::0": { label: "立即" },
	"tasks.todoClearDelay::60": { label: "1 分钟" },
	"tasks.todoClearDelay::300": { label: "5 分钟" },
	"tasks.todoClearDelay::900": { label: "15 分钟" },
	"tasks.todoClearDelay::1800": { label: "30 分钟" },
	"tasks.todoClearDelay::3600": { label: "1 小时" },
	"tasks.todoClearDelay::-1": { label: "从不" },

	// providers.antigravityEndpoint
	"providers.antigravityEndpoint::auto": { label: "自动" },
	"providers.antigravityEndpoint::production": { label: "仅生产环境" },
	"providers.antigravityEndpoint::sandbox": { label: "仅沙箱" },

	// providers.image
	"providers.image::auto": { label: "自动" },
	"providers.image::openai": { label: "OpenAI" },
	"providers.image::openai-codex": { label: "OpenAI Codex (ChatGPT)" },
	"providers.image::antigravity": { label: "Antigravity" },
	"providers.image::xai": { label: "xAI Grok Imagine" },
	"providers.image::gemini": { label: "Gemini" },
	"providers.image::openrouter": { label: "OpenRouter" },

	// providers.fireworksTier
	"providers.fireworksTier::standard": { label: "标准" },
	"providers.fireworksTier::priority": { label: "优先" },

	// providers.tts
	"providers.tts::auto": { label: "自动" },
	"providers.tts::local": { label: "本地" },
	"providers.tts::xai": { label: "xAI Grok Voice" },

	// speech.mode
	"speech.mode::all": { label: "全部（消息 + 思考）" },
	"speech.mode::assistant": { label: "助手消息" },
	"speech.mode::yield": { label: "仅最终消息" },

	// providers.kimiApiFormat
	"providers.kimiApiFormat::openai": { label: "OpenAI" },
	"providers.kimiApiFormat::anthropic": { label: "Anthropic" },

	// providers.openaiWebsockets
	"providers.openaiWebsockets::auto": { label: "自动" },
	"providers.openaiWebsockets::off": { label: "关闭" },
	"providers.openaiWebsockets::on": { label: "开启" },

	// providers.streamFirstEventTimeoutSeconds
	"providers.streamFirstEventTimeoutSeconds::-1": { label: "自动" },
	"providers.streamFirstEventTimeoutSeconds::0": { label: "关闭" },
	"providers.streamFirstEventTimeoutSeconds::300": { label: "5 分钟" },
	"providers.streamFirstEventTimeoutSeconds::600": { label: "10 分钟" },
	"providers.streamFirstEventTimeoutSeconds::1800": { label: "30 分钟" },

	// providers.streamIdleTimeoutSeconds
	"providers.streamIdleTimeoutSeconds::-1": { label: "自动" },
	"providers.streamIdleTimeoutSeconds::0": { label: "关闭" },
	"providers.streamIdleTimeoutSeconds::300": { label: "5 分钟" },
	"providers.streamIdleTimeoutSeconds::600": { label: "10 分钟" },
	"providers.streamIdleTimeoutSeconds::1800": { label: "30 分钟" },

	// providers.openrouterVariant
	"providers.openrouterVariant::default": { label: "默认" },
	"providers.openrouterVariant::nitro": { label: ":nitro" },
	"providers.openrouterVariant::floor": { label: ":floor" },
	"providers.openrouterVariant::online": { label: ":online" },
	"providers.openrouterVariant::exacto": { label: ":exacto" },

	// providers.fetch
	"providers.fetch::auto": { label: "自动" },
	"providers.fetch::native": { label: "原生" },
	"providers.fetch::trafilatura": { label: "Trafilatura" },
	"providers.fetch::lynx": { label: "Lynx" },
	"providers.fetch::parallel": { label: "并行" },
	"providers.fetch::jina": { label: "Jina" },

	// codexResets.autoRedeem
	"codexResets.autoRedeem::unset": { label: "未设置" },
	"codexResets.autoRedeem::yes": { label: "是" },
	"codexResets.autoRedeem::no": { label: "否" },

	// provider.appendOnlyContext
	"provider.appendOnlyContext::auto": { label: "自动" },
	"provider.appendOnlyContext::on": { label: "开启" },
	"provider.appendOnlyContext::off": { label: "关闭" },

	// ═══════════════════════════════════════════════════════════════════════
	// Enum settings (no `ui.options` in schema). These are rendered via the
	// `case "enum"` branch in settings-selector.ts, which now also calls
	// `trOption(path, value, "label", fallback)` for the current value.
	// ═══════════════════════════════════════════════════════════════════════

	// steeringMode
	"steeringMode::all": { label: "全部" },
	"steeringMode::one-at-a-time": { label: "逐条" },

	// followUpMode
	"followUpMode::all": { label: "全部" },
	"followUpMode::one-at-a-time": { label: "逐条" },

	// interruptMode
	"interruptMode::immediate": { label: "立即" },
	"interruptMode::wait": { label: "等待" },

	// doubleEscapeAction
	"doubleEscapeAction::branch": { label: "分支" },
	"doubleEscapeAction::tree": { label: "树" },
	"doubleEscapeAction::none": { label: "无" },

	// treeFilterMode
	"treeFilterMode::default": { label: "默认" },
	"treeFilterMode::no-tools": { label: "无工具" },
	"treeFilterMode::user-only": { label: "仅用户" },
	"treeFilterMode::labeled-only": { label: "仅标记" },
	"treeFilterMode::all": { label: "全部" },

	// completion.notify
	"completion.notify::on": { label: "开启" },
	"completion.notify::off": { label: "关闭" },

	// ask.notify
	"ask.notify::on": { label: "开启" },
	"ask.notify::off": { label: "关闭" },

	// ttsr.contextMode
	"ttsr.contextMode::discard": { label: "丢弃" },
	"ttsr.contextMode::keep": { label: "保留" },

	// ttsr.repeatMode
	"ttsr.repeatMode::once": { label: "一次" },
	"ttsr.repeatMode::after-gap": { label: "间隔后" },

	// python.kernelMode
	"python.kernelMode::session": { label: "会话内复用" },
	"python.kernelMode::per-call": { label: "每次调用新建" },
};
