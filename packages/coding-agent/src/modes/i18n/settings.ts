/**
 * Translation overlay for the settings panel.
 *
 * The settings schema (`settings-schema.ts`) is a const object evaluated
 * at module load — earlier than `initLanguage` runs. So we cannot inline
 * `t()` calls into the schema itself. Instead, this module keeps a
 * separate Chinese translation map keyed by the setting path
 * (`"appearance.language"` etc.) plus the field (`label` / `description`).
 *
 * The renderer (`settings-defs.ts`) calls {@link trSetting} with the
 * schema's English fallback text; when the active language is `zh` and a
 * translation exists, the Chinese text wins. Otherwise the English
 * fallback is returned untouched. This keeps behavior identical to today
 * for any setting that has not been translated yet — gaps surface as
 * English rather than blank, and we can fill them in incrementally.
 */

import type { Language } from "./index";
import { getCurrentLanguage } from "./index";
import { type OptionField, zhOptions } from "./translations/options.zh";
import { type SettingField, zhSettings } from "./translations/settings.zh";
import { zhSlashCommands } from "./translations/slash-commands.zh";
import { zhGroups, zhTabs } from "./translations/tabs-groups.zh";

/**
 * Resolve the localized label or description for a setting path.
 *
 * @param path  Setting path, e.g. `"appearance.language"`.
 * @param field Which UI field — `"label"` (short) or `"description"` (long).
 * @param fallback The English text from the schema, returned when no
 *                 translation exists or the active language is `en`.
 */
export function trSetting(path: string, field: SettingField, fallback: string): string {
	if (getCurrentLanguage() !== "zh") return fallback;
	const entry = zhSettings[path];
	if (!entry) return fallback;
	const value = entry[field];
	return value || fallback;
}

/**
 * Resolve the localized label for a settings tab.
 *
 * @param tab      Tab identifier (`"appearance"`, `"model"`, …).
 * @param fallback The English label from `TAB_METADATA`, returned when no
 *                 translation exists or the active language is `en`.
 */
export function trTab(tab: string, fallback: string): string {
	if (getCurrentLanguage() !== "zh") return fallback;
	return zhTabs[tab] ?? fallback;
}

/**
 * Resolve the localized name for a settings group within a tab.
 *
 * @param tab      Tab identifier (`"appearance"`, `"model"`, …).
 * @param group    Group name as declared in `TAB_GROUPS[tab]` (e.g.
 *                 `"Theme"`, `"Status Line"`).
 * @param fallback The English group name, returned when no translation
 *                 exists or the active language is `en`. Usually equal
 *                 to `group`.
 */
export function trGroup(tab: string, group: string, fallback = group): string {
	if (getCurrentLanguage() !== "zh") return fallback;
	const groupsForTab = zhGroups[tab];
	if (!groupsForTab) return fallback;
	return groupsForTab[group] ?? fallback;
}

/**
 * Resolve the localized description for a builtin slash command.
 *
 * @param name     Command name without leading slash (e.g. `"new"`,
 *                 `"language"`).
 * @param fallback The English description from the registry, returned
 *                 when no translation exists or the active language is
 *                 `en`.
 */
export function trSlashCommand(name: string, fallback: string, lang: Language = getCurrentLanguage()): string {
	if (lang !== "zh") return fallback;
	return zhSlashCommands[name] ?? fallback;
}

/**
 * Resolve the localized label or description for a submenu option.
 *
 * @param path     Setting path owning the option (e.g. `"statusLine.preset"`).
 * @param value    Option value (e.g. `"default"`, `"minimal"`).
 * @param field    Which UI field — `"label"` or `"description"`.
 * @param fallback The English text from the schema, returned when no
 *                 translation exists or the active language is `en`.
 */
export function trOption(path: string, value: string, field: OptionField, fallback: string): string {
	if (getCurrentLanguage() !== "zh") return fallback;
	const key = `${path}::${value}`;
	const entry = zhOptions[key];
	if (!entry) return fallback;
	const v = entry[field];
	return v || fallback;
}
