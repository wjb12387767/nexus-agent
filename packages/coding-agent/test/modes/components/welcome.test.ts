import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("WelcomeComponent tips", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects a tip from the tips pool regardless of symbol preset", () => {
		// The emoji "Please use nerdfont 😭." special-case was removed to
		// keep the welcome screen free of sticker-ish glyphs. Both presets
		// now pull from the same weighted pool in tips.txt.
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");
		const welcomeNerd = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeNerd.tip).toBeDefined();
		expect(welcomeNerd.tip).not.toBe("Please use nerdfont 😭.");

		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeUnicode = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeUnicode.tip).toBeDefined();
		expect(welcomeUnicode.tip).not.toBe("Please use nerdfont 😭.");
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});
});
