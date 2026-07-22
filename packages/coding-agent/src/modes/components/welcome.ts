import {
	type Component,
	matchesKey,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { getCurrentLanguage, getTips, type Language, t } from "../i18n";

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted as a shimmering rainbow. Non-global so `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. */
const NEW_TAG_TEXT = "NEW!";

/** Milliseconds for one full hue rotation of the rainbow "NEW!" tag. */
const NEW_GLOW_PERIOD_MS = 1500;

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

type ColorEncoding = "ansi-16m" | "ansi-256";

/** Paint each glyph of {@link NEW_TAG_TEXT} on a moving HSL rainbow. `phase`
 *  rotates the hue offset cyclically; successive renders with increasing phase
 *  shimmer, while a fixed phase yields a still rainbow. */
function renderNewTag(phase: number, encoding: ColorEncoding): string {
	const bold = "\x1b[1m";
	const reset = "\x1b[0m";
	const wrapped = ((phase % 1) + 1) % 1;
	const chars = [...NEW_TAG_TEXT];
	let out = bold;
	let prev = "";
	for (let i = 0; i < chars.length; i++) {
		const hue = Math.round(((i / chars.length + wrapped) % 1) * 360);
		const color = Bun.color(`hsl(${hue}, 95%, 60%)`, encoding) ?? "";
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += chars[i];
	}
	return out + reset;
}
export function renderWelcomeTip(tip: string, boxWidth: number, phase = 0): string[] {
	// Localized "Tip:" label, padded to keep the body column aligned across
	// re-renders after a `/language` switch (Chinese "提示：" is double-width
	// but visibleWidth accounts for that).
	const label = t("tip.label");
	const labelPad = " ";
	const labelFull = `${label}${labelPad}`;
	const labelWidth = visibleWidth(labelFull);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = isNew ? tip.replace(NEW_TIP_MARKER, "") : tip;

	const wrappedBody = wrapTextWithAnsi(replaceTabs(body), bodyBudget);
	if (wrappedBody.length === 0) return [];

	// Pull both colors from the active theme so the line stays readable on light
	// themes; the previous hardcoded `#b48cff` / `#9ccfff` pastels (plus a manual
	// `\x1b[2m` dim on the body) dropped to ~1.5:1 contrast on a white background.
	const continuationIndent = padding(labelWidth);
	const styledLabel = theme.fg("customMessageLabel", labelFull);

	const lines = wrappedBody.map((line, index) => {
		const styledBody = theme.fg("muted", line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${theme.italic(content)}`;
	});

	if (isNew) {
		// Append the rainbow tag to the final body line when it fits within the
		// box; otherwise drop it onto its own indented continuation line so the
		// styled glyphs never overflow or reflow the wrapped body.
		const encoding: ColorEncoding = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
		const tag = renderNewTag(phase, encoding);
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= boxWidth) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(` ${continuationIndent}${tag}`);
		}
	}

	return lines;
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

/** Action identifiers for the welcome-screen buttons (see {@link WELCOME_BUTTONS}). */
export type WelcomeButtonAction = "new" | "models" | "recent" | "settings" | "help";

/** i18n message key for each button's localized label. */
type ButtonLabelKey = "button.new" | "button.models" | "button.recent" | "button.settings" | "button.help";

/** Button definitions rendered by {@link WelcomeComponent.#renderButtonRow}. The
 *  `key` is the keyboard shortcut (digit 1-5), `labelKey` is the i18n key
 *  resolved at render time (so the row re-renders with the new language on
 *  the next frame after `/language` switches), and `action` is the value
 *  passed to {@link WelcomeComponent.onButtonAction} when the button is
 *  triggered. */
const WELCOME_BUTTONS: ReadonlyArray<readonly [key: string, labelKey: ButtonLabelKey, action: WelcomeButtonAction]> = [
	["1", "button.new", "new"],
	["2", "button.models", "models"],
	["3", "button.recent", "recent"],
	["4", "button.settings", "settings"],
	["5", "button.help", "help"],
];

/**
 * Welcome screen restyled to match MiMo-Code's centered home layout: a
 * block-character NEXUS wordmark in brand orange, "Nexus Agent" tagline,
 * model/provider info, and a row of action buttons with keyboard shortcuts
 * 1-5. The legacy two-column bordered box was replaced with a flush,
 * centered composition that mirrors MiMo-Code's visual identity.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#selectedTip: string | undefined;
	// Tips pool snapshot used to pick {@link #selectedTip}. Compared by
	// reference so a language switch (which swaps the pool) triggers a
	// re-roll without re-rolling on every render.
	#tipPool: readonly string[] | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;
	// Language snapshot at the time the cache was populated. Compared on
	// every render against the live i18n language so a `/language` switch
	// busts the cache and re-renders in the new language on the next frame.
	#cachedLang: Language | undefined;
	/** Optional callback fired when a welcome button is triggered (keyboard 1-5
	 *  via {@link handleInput} or external key listener). Host wires this to the
	 *  matching slash command (`/new`, `/models`, `/resume`, `/settings`, `/help`). */
	onButtonAction?: (action: WelcomeButtonAction) => void;

	constructor(
		// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for future welcome-screen surfaces (recent sessions / LSP panels); setters are still called by InteractiveMode.
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		// biome-ignore lint/correctness/noUnusedPrivateClassMembers: populated by setRecentSessions; render currently omits the list to match MiMo-Code's centered home layout.
		private recentSessions: RecentSession[] = [],
		// biome-ignore lint/correctness/noUnusedPrivateClassMembers: populated by setLspServers; render currently omits the list to match MiMo-Code's centered home layout.
		private lspServers: LspServerInfo[] = [],
	) {}
	get tip(): string | undefined {
		// Re-pick when the tip pool changes (language switch swaps the
		// en/zh tips file). The pool identity is stable per language, so
		// this only re-rolls on `/language` switches, not every render.
		const pool = getTips();
		if (this.#selectedTip === undefined || this.#tipPool !== pool) {
			this.#tipPool = pool;
			this.#selectedTip = pickWeightedTip(pool, Math.random());
		}
		return this.#selectedTip || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#cachedLang = undefined;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
		this.invalidate();
	}

	/**
	 * Component interface: route digit keys 1-5 to the matching welcome
	 * button's {@link onButtonAction} callback. Only fires when this
	 * component holds focus; the host also wires a global key listener so
	 * the buttons work from the editor (the usual resting focus) without
	 * requiring the welcome box itself to be focused.
	 */
	handleInput(data: string): void {
		if (matchesKey(data, "1")) this.onButtonAction?.("new");
		else if (matchesKey(data, "2")) this.onButtonAction?.("models");
		else if (matchesKey(data, "3")) this.onButtonAction?.("recent");
		else if (matchesKey(data, "4")) this.onButtonAction?.("settings");
		else if (matchesKey(data, "5")) this.onButtonAction?.("help");
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		// Detect language changes since the last render so a `/language zh`
		// mid-session invalidates the cached lines and the next frame picks
		// up the new button labels, tip prefix, and tips pool. Without this
		// the cache would serve the stale English (or Chinese) render until
		// a width change or animation tick happens to bust it.
		const lang = getCurrentLanguage();
		if (lang !== this.#cachedLang) {
			this.#cachedLang = lang;
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		}
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		// MiMo-Code home layout, ported to the scrollback-area Component
		// contract: the NEXUS wordmark sits at the horizontal center of the
		// terminal (not a fixed 100-col cap, which left the block flush-left
		// on wide terminals), with the "Nexus Agent" tagline right-aligned
		// to the wordmark's top-right corner the way MiMo-Code places
		// "Xiaomi" at the top-right of the MIMO+CODE block. Below: a muted
		// model · provider line, then a single row of action buttons
		// rendered without the bracketed "sticker" look that made the
		// earlier version feel cheap.
		const width = Math.max(0, termWidth);
		if (width < 4) {
			return [];
		}

		const lines: string[] = [];

		// Top breathing room. The transcript area cannot vertically center
		// its contents (Component only knows its width, not the viewport
		// height), so a fixed top margin is the closest approximation of
		// MiMo-Code's flexGrow={1} spring. Five rows lifts the wordmark
		// out of the upper-left corner without pushing the buttons off-screen
		// on a 24-row terminal.
		lines.push("", "", "", "", "");

		// Logo frame (intro animation or resting).
		const logoColored = this.#currentLogoFrame();
		const logoWidth = logoColored.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

		// Tagline row: blank line with "Nexus Agent" right-aligned to the
		// logo's right edge. MiMo-Code's logo data has its first row as
		// blank space with "Xiaomi" at the right; NEXUS_LOGO's first row
		// is the wordmark itself, so the tagline goes on a dedicated row
		// above the logo to occupy the same visual corner.
		const taglineColor = solidFg(NEXUS_GRAY_RGB, NEXUS_GRAY_256);
		const reset = "\x1b[0m";
		const tagline = `${taglineColor}Nexus Agent${reset}`;
		const taglineWidth = visibleWidth(tagline);
		const logoLeftPad = Math.floor((width - logoWidth) / 2);
		if (logoLeftPad + logoWidth <= width && logoLeftPad + logoWidth - taglineWidth >= 0) {
			const taglineLeft = logoLeftPad + logoWidth - taglineWidth;
			lines.push(padding(taglineLeft) + tagline);
		} else {
			lines.push("");
		}

		// Logo rows, centered.
		for (const line of logoColored) {
			lines.push(this.#centerText(line, width));
		}

		lines.push("");

		// Model · provider, muted, centered. No "Welcome back!" header —
		// MiMo-Code has no such headline, and the exclamation read as
		// sticker-ish next to the wordmark.
		const modelInfo = `${theme.fg("muted", this.modelName)} ${theme.fg("dim", "·")} ${theme.fg("borderMuted", this.providerName)}`;
		lines.push(this.#centerText(modelInfo, width));

		lines.push("");

		// Action buttons row — centered, hidden when the terminal is too
		// narrow to fit all five side-by-side.
		const buttonRow = this.#renderButtonRow();
		if (visibleWidth(buttonRow) <= width) {
			lines.push(this.#centerText(buttonRow, width));
		}

		lines.push("");

		// Randomly picked tip, rendered beneath the buttons.
		lines.push(...this.#renderTip(width));

		return lines;
	}

	/**
	 * Build the action-button row: digit shortcuts in brand orange followed
	 * by bold labels, separated by generous spacing. No bracket chrome —
	 * the earlier `[1 New]` stickers read as emoji-ish pasted glyphs; the
	 * bare `1 New  2 Models` form mirrors the quiet key hints MiMo-Code
	 * uses for its prompt-area shortcuts.
	 */
	#renderButtonRow(): string {
		const orange = solidFg(NEXUS_ORANGE_RGB, NEXUS_ORANGE_256);
		const reset = "\x1b[0m";
		const bold = "\x1b[1m";
		return WELCOME_BUTTONS.map(([key, labelKey]) => `${orange}${key}${reset} ${bold}${t(labelKey)}${reset}`).join(
			"    ",
		);
	}

	/**
	 * Render the per-instance tip line: the `customMessageLabel`-themed `Tip:`
	 * label followed by a `muted` body, the whole line italicized. Returns `[]`
	 * when no tip is available or the box is too narrow to be useful.
	 */
	#renderTip(boxWidth: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		// A trailing "[NEW]" marker paints an animated rainbow "NEW!" tag. Derive
		// its hue phase from wall-clock time so it shimmers across the welcome
		// intro's re-render frames, then settles into a still rainbow once the box
		// caches its resting frame. Non-"[NEW]" tips ignore the phase entirely.
		const phase = NEW_TIP_MARKER.test(tip) ? performance.now() / NEW_GLOW_PERIOD_MS : 0;
		return renderWelcomeTip(tip, boxWidth, phase);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(): readonly string[] {
		if (this.#animStart == null) return REST_FRAME;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAME;
		return introLogoFrame(elapsed / INTRO_MS);
	}
}

export const PI_LOGO = ["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "];

/**
 * NEXUS block-character logo, styled to match MiMo-Code's MIMO/CODE wordmark.
 * 6 rows tall, 47 columns wide. Used by the restyled welcome screen so the
 * branding reads as the agent's own name instead of the upstream "PI" glyph.
 */
export const NEXUS_LOGO: readonly string[] = [
	"███╗   ██╗ ███████╗ ██╗  ██╗ ██╗   ██╗ ███████╗",
	"████╗  ██║ ██╔════╝ ╚██╗██╔╝ ██║   ██║ ██╔════╝",
	"██╔██╗ ██║ ███████╗  ╚████╔╝ ██║   ██║ ███████╗",
	"██║╚██╗██║ ██╔═══╝    ╚██╔╝  ██║   ██║ ╚════██║",
	"██║ ╚████║ ███████╗   ██╔╝   ╚██████╔╝ ███████║",
	"╚═╝  ╚═══╝ ╚══════╝   ╚═╝     ╚═════╝  ╚══════╝",
];

/**
 * MiMo-Code brand orange (RGB 251, 129, 71), used for the NEXUS wordmark and
 * the action-button accents so the welcome screen matches MiMo-Code's visual
 * identity. The 256-color fallback is the nearest xterm cube slot.
 */
const NEXUS_ORANGE_RGB: readonly [number, number, number] = [251, 129, 71];
const NEXUS_ORANGE_256 = 173;

/** Gray used for the "Nexus Agent" tagline beneath the wordmark. */
const NEXUS_GRAY_RGB: readonly [number, number, number] = [160, 160, 160];
const NEXUS_GRAY_256 = 244;

/** Resolve a truecolor or 256-color foreground escape for the given RGB. */
function solidFg(rgb: readonly [number, number, number], fallback256: number): string {
	if (TERMINAL.trueColor) {
		return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	}
	return `\x1b[38;5;${fallback256}m`;
}

/**
 * Multi-stop palette for the diagonal gradient. Orange tones matching
 * MiMo-Code's brand color (RGB 251, 129, 71); the diagonal lightens to
 * near-white so the intro shine sweep reads as a highlight passing across
 * the NEXUS wordmark rather than a rainbow.
 */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[251, 129, 71], // MiMo-Code orange (base)
	[255, 165, 100], // lighter orange
	[255, 200, 150], // light orange
	[255, 230, 200], // very light orange
	[255, 250, 240], // near-white (peak for shine band)
];

/** 256-color ramp fallback when truecolor isn't available (orange ramp). */
const GRADIENT_RAMP_256 = [166, 172, 178, 180, 217, 223, 231];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (TERMINAL.trueColor) {
		// 5-stop palette widens the visible color range and avoids the
		// deep-blue valley a naive HSL lerp falls into.
		const stops = GRADIENT_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		let r = a[0] + (b[0] - a[0]) * f;
		let g = a[1] + (b[1] - a[1]) * f;
		let bl = a[2] + (b[2] - a[2]) * f;
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const ramp = GRADIENT_RAMP_256;
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	// span+1 so `base` stays strictly < 1: avoids the wrap-around at the
	// far corner mapping back to t=0 (hot pink) on the resting frame.
	const span = Math.max(1, cols + rows - 1);
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
			const base = (x + (rows - 1 - y)) / span;
			const t = (((base + phase) % 1) + 1) % 1;
			result += gradientEscape(t, shine) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the resting state. The gradient
 * sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` → phase =
 * 0 = resting frame) while the shine traverses the diagonal at a steady pace,
 * decoupled from the gradient phase so the two layers parallax; its strength
 * fades with the same ease-out curve so the highlight is gone by the resting
 * frame.
 */
function introLogoFrame(progress: number): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
	const shineStrength = (1 - eased) ** 1.5;
	return gradientLogo(NEXUS_LOGO, phase, { strength: shineStrength, pos: shinePos });
}

/** Resting gradient frame, cached for re-renders outside of the intro. */
const REST_FRAME = gradientLogo(NEXUS_LOGO, 0);
