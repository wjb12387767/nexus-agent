/**
 * Lightweight i18n module for the welcome screen and its action buttons.
 *
 * No external i18n library — the surface is tiny (a handful of UI labels
 * plus the tips pool) and the existing codebase deliberately avoids i18n
 * (see `interactive-mode.ts` ~L3686). This module keeps the same spirit:
 * a single in-memory language state, a flat key→string catalog, and a
 * swapable tips pool. Brand-identity strings (NEXUS wordmark, "Nexus
 * Agent" tagline) bypass the catalog and stay fixed across locales.
 *
 * Lifecycle:
 *  1. {@link initLanguage} is called once during InteractiveMode boot,
 *     passing the user's `language` setting (`auto` | `en` | `zh`).
 *     `auto` probes `LANG` / `LC_ALL` / `LC_MESSAGES` and falls back to the
 *     runtime ICU locale (`Intl.DateTimeFormat`) so Windows — where the Unix
 *     env vars are usually unset — still detects `zh` from the display
 *     language.
 *  2. {@link t} reads from the active catalog. Missing keys fall back to
 *     the key itself (visible breadcrumb, never a blank).
 *  3. {@link setLanguage} swaps the active language at runtime (used by
 *     the `/language` slash command) and returns the resolved language
 *     so the caller can render a confirmation message.
 *  4. {@link getTips} returns the tips pool for the active language so
 *     the welcome screen picks a localized tip without each call site
 *     having to know which file to import.
 */

import enTipsText from "../components/tips.txt" with { type: "text" };
import zhTipsText from "../components/tips.zh.txt" with { type: "text" };
import type { MessageCatalog } from "./messages";
import { enMessages, zhMessages } from "./messages";

/** Concrete UI language (after `auto` resolution). */
export type Language = "en" | "zh";

/** User-facing setting value. `auto` means detect from environment. */
export type LanguageSetting = "auto" | Language;

const CATALOGS: Record<Language, MessageCatalog> = {
	en: enMessages,
	zh: zhMessages,
};

/** Parsed tips pool per language (one entry per non-blank source line). */
const TIPS: Record<Language, readonly string[]> = {
	en: parseTips(enTipsText),
	zh: parseTips(zhTipsText),
};

let currentLanguage: Language = "en";
let initialized = false;

function parseTips(text: string): readonly string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

/**
 * Resolve `auto` to a concrete language.
 *
 * Probe order:
 *  1. Unix-style env vars `LANG` / `LC_ALL` / `LC_MESSAGES` (`zh*` prefix → `zh`).
 *     On Windows these are usually unset, so we fall through.
 *  2. The runtime's ICU locale via `Intl.DateTimeFormat().resolvedOptions().locale`,
 *     which on Windows correctly returns BCP 47 tags like `zh-CN` / `zh-Hans`
 *     based on the user's display language (set via Settings → Time & Language).
 *     This is the primary signal on Windows where the Unix env vars are absent.
 *
 * Anything non-`zh*` (including unset/empty and detection failures) → `en`.
 * Lowercased prefix match so the region/script suffix never trips the check.
 */
export function detectLanguage(): Language {
	const env = process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? "";
	if (env.toLowerCase().startsWith("zh")) return "zh";
	try {
		const intl = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
		if (intl.startsWith("zh")) return "zh";
	} catch {
		// Intl not available (very unusual in Bun/Node) — fall through to en.
	}
	return "en";
}

/**
 * Resolve a {@link LanguageSetting} to a concrete {@link Language}. `auto`
 * delegates to {@link detectLanguage}; `en`/`zh` pass through.
 */
export function resolveLanguage(setting: LanguageSetting): Language {
	return setting === "auto" ? detectLanguage() : setting;
}

/**
 * Initialize the i18n module from the user's `language` setting. Safe to
 * call multiple times — later calls override earlier ones (used when the
 * setting changes via `/settings` and the session re-inits).
 */
export function initLanguage(setting: LanguageSetting): Language {
	currentLanguage = resolveLanguage(setting);
	initialized = true;
	return currentLanguage;
}

/** Current concrete language. Falls back to `en` if {@link initLanguage} was never called. */
export function getCurrentLanguage(): Language {
	return initialized ? currentLanguage : "en";
}

/**
 * Swap the active language at runtime. Used by the `/language` slash
 * command. Does NOT persist the setting — the caller is expected to write
 * `settings.set("language", lang)` if persistence is desired.
 */
export function setLanguage(lang: Language): Language {
	currentLanguage = lang;
	initialized = true;
	return currentLanguage;
}

/**
 * Translate a catalog key. Missing keys fall back to the key itself so a
 * translation gap is visible rather than blank. Supports `{placeholder}`
 * interpolation via the optional `params` map.
 */
export function t(key: keyof MessageCatalog, params?: Record<string, string>): string {
	const catalog = CATALOGS[currentLanguage];
	const value = catalog[key] ?? enMessages[key] ?? (key as string);
	if (!params) return value;
	return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "");
}

/**
 * Localized tips pool for the active language. The welcome screen picks a
 * random tip from this list; each language's file is sourced at build
 * time via `import … with { type: "text" }` so there is no runtime file
 * I/O.
 */
export function getTips(): readonly string[] {
	return TIPS[currentLanguage];
}

/** Human-readable name for a language, in that language (for status output). */
export function languageDisplayName(lang: Language): string {
	const key = `language.name.${lang}` as keyof MessageCatalog;
	return CATALOGS[lang][key];
}
