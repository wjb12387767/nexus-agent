/**
 * UI message catalog for the welcome screen, its action buttons, the
 * settings panel hint lines, and the `/help` slash command.
 *
 * Keys are flat dotted strings (`button.new`, `tip.label`,
 * `settings.hint.change`) so a missing translation falls back to the key
 * itself — visible in the UI as a breadcrumb that something needs
 * translating, never a blank. The `en` map is the source of truth; `zh`
 * mirrors its keys exactly.
 *
 * Brand-identity strings (the NEXUS wordmark, the "Nexus Agent" tagline)
 * are intentionally NOT in this catalog — they are proper nouns and stay
 * fixed across locales.
 */

export interface MessageCatalog {
	/** Action-button labels (welcome screen shortcut row). */
	"button.new": string;
	"button.models": string;
	"button.recent": string;
	"button.settings": string;
	"button.help": string;
	/** Tip-line prefix shown before each random tip. */
	"tip.label": string;
	/** One-line status shown when the language is switched at runtime. */
	"language.switched": string;
	/** Status line label shown for the current language setting. */
	"language.name.en": string;
	"language.name.zh": string;
	/** Settings panel footer hints, shown dimmed at the bottom of the overlay. */
	"settings.hint.input.save": string;
	"settings.hint.select": string;
	"settings.hint.provider.edit": string;
	"settings.hint.search": string;
	"settings.hint.plugins": string;
	"settings.hint.sectionJump": string;
	"settings.hint.default": string;
	"settings.hint.defaultWithSectionJump": string;
	"settings.hint.tabSwitch": string;
	/** Settings panel search-result counter, singular and plural. */
	"settings.search.matchSingular": string;
	"settings.search.matchPlural": string;
	/** Empty-state text shown when a settings search returns no matches. */
	"settings.search.empty": string;
	/** Submenu preview label. */
	"settings.submenu.preview": string;
	/** Provider limits panel: title, intro line, per-row description, and clear-all action. */
	"settings.providerLimits.title": string;
	"settings.providerLimits.intro": string;
	"settings.providerLimits.unlimited": string;
	"settings.providerLimits.limit": string;
	"settings.providerLimits.clearAll": string;
	"settings.providerLimits.clearAllDesc": string;
	"settings.providerLimits.errorPositive": string;
	/** Top-border title for the settings overlay, and inline preview label for the appearance tab. */
	"settings.overlayTitle": string;
	"settings.previewLabel": string;
	/** Boolean display values shown on the right side of a boolean setting row. */
	"settings.boolean.true": string;
	"settings.boolean.false": string;
	/** Status line preview fallback when no preview callback is wired up. */
	"settings.previewNotAvailable": string;
	/** Error thrown when a record-typed setting receives invalid JSON. */
	"settings.error.invalidRecordJson": string;
	/** Provider limits editor submenu: title and description for the per-provider input. */
	"settings.providerLimits.editorTitle": string;
	"settings.providerLimits.editorDesc": string;
	/** Plugins tab: list header, empty state, install hints, and footer hints. */
	"plugins.title": string;
	"plugins.empty": string;
	"plugins.installNpm": string;
	"plugins.installMarketplace": string;
	"plugins.hint.configure": string;
	"plugins.hint.edit": string;
	"plugins.hint.toggle": string;
	"plugins.hint.select": string;
	"plugins.hint.save": string;
	/** Plugins tab: list row badges and details. */
	"plugins.badge.npm": string;
	"plugins.badge.marketplace": string;
	"plugins.features": string;
	"plugins.shadowedBy": string;
	/** Plugins tab: enable/disable toggle label + descriptions. */
	"plugins.enabled.label": string;
	"plugins.enabled.description": string;
	"plugins.enabled.marketplaceDescription": string;
	"plugins.feature.defaultDescription": string;
	"plugins.notSet": string;
	"plugins.unknown": string;
	"plugins.config.defaultDescription": string;
	"plugins.config.selectValue": string;
	"plugins.config.typeHint": string;
	"plugins.config.rangeHint": string;
	/** Plugins tab: marketplace read-only metadata labels. */
	"plugins.metadata.version": string;
	"plugins.metadata.scope": string;
	"plugins.metadata.installPath": string;
	"plugins.metadata.installedAt": string;
	"plugins.metadata.lastUpdated": string;
	"plugins.metadata.gitSha": string;
	/** Snapcompact shape preview: stats line, status messages, and error. */
	"settings.snapcompact.stats": string;
	"settings.snapcompact.needKitty": string;
	"settings.snapcompact.rendering": string;
	"settings.snapcompact.renderFailed": string;
	"settings.snapcompact.needUnicodePlaceholder": string;
	"settings.snapcompact.emptyFrame": string;
	/** `/help` slash command output. */
	"help.title": string;
	"help.intro": string;
	"help.commands.header": string;
	"help.footer": string;
	"help.table.command": string;
	"help.table.description": string;
}

/** English message catalog (source of truth). */
export const enMessages: MessageCatalog = {
	"button.new": "New",
	"button.models": "Models",
	"button.recent": "Recent",
	"button.settings": "Settings",
	"button.help": "Help",
	"tip.label": "Tip:",
	"language.switched": "Language switched to {lang}",
	"language.name.en": "English",
	"language.name.zh": "中文",
	"settings.hint.input.save": "Enter to save · Esc to cancel · Clear field to unset",
	"settings.hint.select": "Enter to select · Esc to go back",
	"settings.hint.provider.edit": "Enter to edit provider · Esc to go back",
	"settings.hint.search": "Enter to change · Tab to jump tabs · Esc to exit search",
	"settings.hint.plugins": "Tab to switch tabs · Esc to close",
	"settings.hint.sectionJump": "↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · Esc to close",
	"settings.hint.default": "Enter/Space to change · {nav} · Type to search · Esc to close",
	"settings.hint.defaultWithSectionJump": "Tab to jump sections · ←/→ to switch tabs",
	"settings.hint.tabSwitch": "Tab to switch tabs",
	"settings.search.matchSingular": "1 match",
	"settings.search.matchPlural": "{count} matches",
	"settings.search.empty": "No matching settings",
	"settings.submenu.preview": "Preview:",
	"settings.providerLimits.title": "Max In-Flight Requests",
	"settings.providerLimits.intro":
		"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
	"settings.providerLimits.unlimited": "Unlimited",
	"settings.providerLimits.limit": "Limit: {limit}",
	"settings.providerLimits.clearAll": "Clear all limits",
	"settings.providerLimits.clearAllDesc": "Make every provider unlimited",
	"settings.providerLimits.errorPositive": "Limit must be a positive number.",
	"settings.overlayTitle": "Settings",
	"settings.previewLabel": "Preview:",
	"settings.boolean.true": "On",
	"settings.boolean.false": "Off",
	"settings.previewNotAvailable": "(preview not available)",
	"settings.error.invalidRecordJson": "Invalid record JSON for {path}",
	"settings.providerLimits.editorTitle": "Max In-Flight Requests: {provider}",
	"settings.providerLimits.editorDesc":
		"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
	"plugins.title": "  Plugins",
	"plugins.empty": "  No plugins installed",
	"plugins.installNpm": "  Install npm plugins:        omp plugin install <package>",
	"plugins.installMarketplace": "  Install marketplace plugins: omp plugin install <name>@<marketplace>",
	"plugins.hint.configure": "  Enter to configure · Esc to go back",
	"plugins.hint.edit": "  Enter to edit · Esc to go back",
	"plugins.hint.toggle": "  Enter to toggle · Esc to go back",
	"plugins.hint.select": "  Enter to select · Esc to cancel",
	"plugins.hint.save": "  Enter to save · Esc to cancel",
	"plugins.badge.npm": "[npm]",
	"plugins.badge.marketplace": "[marketplace]",
	"plugins.features": "{enabled}/{count} features",
	"plugins.shadowedBy": "shadowed by {name}",
	"plugins.enabled.label": "Enabled",
	"plugins.enabled.description": "Enable or disable this plugin",
	"plugins.enabled.marketplaceDescription": "Enable or disable this marketplace plugin",
	"plugins.feature.defaultDescription": "Enable {name} feature",
	"plugins.notSet": "(not set)",
	"plugins.unknown": "(unknown)",
	"plugins.config.defaultDescription": "Configure {key}",
	"plugins.config.selectValue": "Select value for {key}",
	"plugins.config.typeHint": "Type: {type}",
	"plugins.config.rangeHint": " ({min}..{max})",
	"plugins.metadata.version": "  version       {value}",
	"plugins.metadata.scope": "  scope         {value}",
	"plugins.metadata.installPath": "  install path  {value}",
	"plugins.metadata.installedAt": "  installed at  {value}",
	"plugins.metadata.lastUpdated": "  last updated  {value}",
	"plugins.metadata.gitSha": "  git sha       {value}",
	"settings.snapcompact.stats": "full frame {cols}×{rows} cells ≈ {chars} chars ≈ {tokens} tokens",
	"settings.snapcompact.needKitty": "  (graphic sample needs a Kitty-graphics terminal)",
	"settings.snapcompact.rendering": "  rendering sample…",
	"settings.snapcompact.renderFailed": "  (sample render failed)",
	"settings.snapcompact.needUnicodePlaceholder": "  (graphic sample needs Kitty unicode-placeholder graphics)",
	"settings.snapcompact.emptyFrame": "empty sample frame",
	"help.title": "Help",
	"help.intro": "Type a / command below. Common commands:",
	"help.commands.header": "Commands",
	"help.footer": "Type /hotkeys for keyboard shortcuts · /changelog for release notes",
	"help.table.command": "Command",
	"help.table.description": "Description",
};

/** Simplified Chinese message catalog. */
export const zhMessages: MessageCatalog = {
	"button.new": "新建",
	"button.models": "模型",
	"button.recent": "最近",
	"button.settings": "设置",
	"button.help": "帮助",
	"tip.label": "提示：",
	"language.switched": "语言已切换为 {lang}",
	"language.name.en": "English",
	"language.name.zh": "中文",
	"settings.hint.input.save": "回车保存 · Esc 取消 · 清空字段可清除设置",
	"settings.hint.select": "回车选择 · Esc 返回",
	"settings.hint.provider.edit": "回车编辑服务商 · Esc 返回",
	"settings.hint.search": "回车修改 · Tab 切换标签 · Esc 退出搜索",
	"settings.hint.plugins": "Tab 切换标签 · Esc 关闭",
	"settings.hint.sectionJump": "↑/↓ 跳转分组 · Tab/回车 进入设置 · ←/→ 切换标签 · Esc 关闭",
	"settings.hint.default": "回车/空格 修改 · {nav} · 输入即搜索 · Esc 关闭",
	"settings.hint.defaultWithSectionJump": "Tab 跳转分组 · ←/→ 切换标签",
	"settings.hint.tabSwitch": "Tab 切换标签",
	"settings.search.matchSingular": "1 条匹配",
	"settings.search.matchPlural": "{count} 条匹配",
	"settings.search.empty": "没有匹配的设置",
	"settings.submenu.preview": "预览：",
	"settings.providerLimits.title": "最大并发请求数",
	"settings.providerLimits.intro": "选择一个服务商，输入正整数以限制并发 LLM 请求数，或清空以解除限制。",
	"settings.providerLimits.unlimited": "无限制",
	"settings.providerLimits.limit": "限制：{limit}",
	"settings.providerLimits.clearAll": "清除所有限制",
	"settings.providerLimits.clearAllDesc": "将所有服务商设为无限制",
	"settings.providerLimits.errorPositive": "限制必须为正数。",
	"settings.overlayTitle": "设置",
	"settings.previewLabel": "预览：",
	"settings.boolean.true": "开",
	"settings.boolean.false": "关",
	"settings.previewNotAvailable": "（预览不可用）",
	"settings.error.invalidRecordJson": "{path} 的 record JSON 无效",
	"settings.providerLimits.editorTitle": "最大并发请求数：{provider}",
	"settings.providerLimits.editorDesc": "输入正整数。小数向下取整。清空字段可让该服务商不受限制。",
	"plugins.title": "  插件",
	"plugins.empty": "  未安装任何插件",
	"plugins.installNpm": "  安装 npm 插件：        omp plugin install <package>",
	"plugins.installMarketplace": "  安装市场插件：         omp plugin install <name>@<marketplace>",
	"plugins.hint.configure": "  回车配置 · Esc 返回",
	"plugins.hint.edit": "  回车编辑 · Esc 返回",
	"plugins.hint.toggle": "  回车切换 · Esc 返回",
	"plugins.hint.select": "  回车选择 · Esc 取消",
	"plugins.hint.save": "  回车保存 · Esc 取消",
	"plugins.badge.npm": "[npm]",
	"plugins.badge.marketplace": "[市场]",
	"plugins.features": "{enabled}/{count} 个功能",
	"plugins.shadowedBy": "被 {name} 覆盖",
	"plugins.enabled.label": "启用",
	"plugins.enabled.description": "启用或禁用此插件",
	"plugins.enabled.marketplaceDescription": "启用或禁用此市场插件",
	"plugins.feature.defaultDescription": "启用 {name} 功能",
	"plugins.notSet": "（未设置）",
	"plugins.unknown": "（未知）",
	"plugins.config.defaultDescription": "配置 {key}",
	"plugins.config.selectValue": "为 {key} 选择值",
	"plugins.config.typeHint": "类型：{type}",
	"plugins.config.rangeHint": "（{min}..{max}）",
	"plugins.metadata.version": "  版本          {value}",
	"plugins.metadata.scope": "  作用域        {value}",
	"plugins.metadata.installPath": "  安装路径      {value}",
	"plugins.metadata.installedAt": "  安装于        {value}",
	"plugins.metadata.lastUpdated": "  最后更新      {value}",
	"plugins.metadata.gitSha": "  Git SHA       {value}",
	"settings.snapcompact.stats": "整帧 {cols}×{rows} 单元 ≈ {chars} 字符 ≈ {tokens} token",
	"settings.snapcompact.needKitty": "  （图形样本需要 Kitty 图形终端）",
	"settings.snapcompact.rendering": "  正在渲染样本…",
	"settings.snapcompact.renderFailed": "  （样本渲染失败）",
	"settings.snapcompact.needUnicodePlaceholder": "  （图形样本需要 Kitty unicode-placeholder 图形支持）",
	"settings.snapcompact.emptyFrame": "空样本帧",
	"help.title": "帮助",
	"help.intro": "在下方输入 / 命令。常用命令：",
	"help.commands.header": "命令",
	"help.footer": "输入 /hotkeys 查看快捷键 · /changelog 查看更新日志",
	"help.table.command": "命令",
	"help.table.description": "说明",
};
