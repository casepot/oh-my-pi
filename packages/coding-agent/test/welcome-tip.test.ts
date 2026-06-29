import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import {
	PI_LOGO,
	renderWelcomeShaderPanel,
	renderWelcomeTip,
	WELCOME_SHADER_PANEL_INNER_HEIGHT,
	WELCOME_SHADER_PANEL_INNER_WIDTH,
	WelcomeComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import {
	getThemeByName,
	initTheme,
	setTheme,
	setThemeInstance,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const stripAnsiLines = (lines: readonly string[]): string[] => lines.map(line => Bun.stripANSI(line));

const SHADER_PANEL_WIDTH = WELCOME_SHADER_PANEL_INNER_WIDTH + 2;
const SHADER_PANEL_HEIGHT = WELCOME_SHADER_PANEL_INNER_HEIGHT + 2;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

afterEach(() => {
	vi.useRealTimers();
});

function expectRoundedPanelBorder(lines: readonly string[]): void {
	expect(lines[0]).toStartWith("╭");
	expect(lines[0]).toEndWith("╮");
	expect(lines[lines.length - 1]).toStartWith("╰");
	expect(lines[lines.length - 1]).toEndWith("╯");
	for (const line of lines.slice(1, -1)) {
		expect(line).toStartWith("│");
		expect(line).toEndWith("│");
	}
}

describe("renderWelcomeShaderPanel", () => {
	it("renders a fixed-size rounded panel with a time-varying visible frame", () => {
		const firstFrame = renderWelcomeShaderPanel(0);
		const secondFrame = renderWelcomeShaderPanel(900);
		const firstPlain = stripAnsiLines(firstFrame);
		const secondPlain = stripAnsiLines(secondFrame);

		expect(firstPlain).toHaveLength(SHADER_PANEL_HEIGHT);
		expect(secondPlain).toHaveLength(SHADER_PANEL_HEIGHT);
		for (const line of firstFrame) {
			expect(visibleWidth(line)).toBe(SHADER_PANEL_WIDTH);
		}
		for (const line of secondFrame) {
			expect(visibleWidth(line)).toBe(SHADER_PANEL_WIDTH);
		}
		expectRoundedPanelBorder(firstPlain);
		expectRoundedPanelBorder(secondPlain);
		expect(firstPlain.join("\n")).not.toBe(secondPlain.join("\n"));
	});
});

describe("WelcomeComponent", () => {
	it("renders the startup shader panel instead of the PI logo", () => {
		const termWidth = 100;
		const lines = new WelcomeComponent("15.6.0", "GPT-5.5", "openai-codex", [], []).render(termWidth);
		const plain = stripAnsiLines(lines);
		const boxEnd = plain.findIndex(line => line.startsWith("╰"));
		const boxPlain = plain.slice(0, boxEnd + 1);
		const shaderTopBorder = `╭${"─".repeat(WELCOME_SHADER_PANEL_INNER_WIDTH)}╮`;
		const logoFragments = PI_LOGO.map(line => Bun.stripANSI(line).trim()).filter(line => line.length > 0);

		expect(boxEnd).toBeGreaterThan(0);
		expect(boxPlain.join("\n")).toContain("GPT-5.5");
		expect(boxPlain.join("\n")).toContain("openai-codex");
		expect(
			plain.some(line => {
				const borderStart = line.indexOf(shaderTopBorder);
				return line.startsWith("│") && borderStart > 0 && borderStart < 27;
			}),
		).toBe(true);
		for (const line of boxPlain) {
			for (const fragment of logoFragments) {
				expect(line).not.toContain(fragment);
			}
		}
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(termWidth);
		}
	});

	it("keeps requesting shader frames until disposed", () => {
		vi.useFakeTimers();
		const component = new WelcomeComponent("15.6.0", "GPT-5.5", "openai-codex", [], []);
		const requestRender = vi.fn();

		try {
			component.playIntro(requestRender);
			expect(requestRender).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(3100);
			const callsAfterIntroDuration = requestRender.mock.calls.length;

			vi.advanceTimersByTime(900);
			expect(requestRender.mock.calls.length).toBeGreaterThan(callsAfterIntroDuration);

			component.dispose();
			const callsAfterDispose = requestRender.mock.calls.length;

			vi.advanceTimersByTime(100);
			expect(requestRender).toHaveBeenCalledTimes(callsAfterDispose);
		} finally {
			component.dispose();
		}
	});
});

describe("renderWelcomeTip", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("wraps long tips under the label instead of truncating", () => {
		const tip = "Next time you see spaghetti try creating a TTSR rule that prevents this pattern before it spreads";
		const width = 44;
		const lines = renderWelcomeTip(tip, width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.length).toBeGreaterThan(1);
		expect(plain.join(" ")).not.toContain("…");
		expect(plain[0]).toStartWith(" Tip: Next time");
		expect(plain[1]).toStartWith("      ");
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("replaces a trailing [NEW] marker with a rainbow NEW! tag", () => {
		const lines = renderWelcomeTip("Try the shiny advisor [NEW]", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		const styled = lines.join("\n");

		expect(plain).toContain("Try the shiny advisor");
		expect(plain).not.toContain("[NEW]"); // literal marker stripped
		expect(plain).toContain("NEW!"); // replaced by the visible tag
		expect(styled).toContain("\x1b[1m"); // tag is bold
		expect(styled).not.toBe(plain); // tag carries SGR color escapes
	});

	it("keeps the NEW! tag within the box width", () => {
		// A width that leaves the wrapped body ending near the right edge forces
		// the tag onto its own continuation line rather than overflowing.
		for (const width of [24, 40, 60]) {
			const lines = renderWelcomeTip("Turn on the advisor to review every turn [NEW]", width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(lines.map(l => Bun.stripANSI(l)).join("\n")).toContain("NEW!");
		}
	});

	it("shimmers the tag across phases without changing visible text", () => {
		const tip = "Fresh feature here [NEW]";
		const still = renderWelcomeTip(tip, 60, 0);
		const shifted = renderWelcomeTip(tip, 60, 0.5);

		expect(shifted.join("\n")).not.toBe(still.join("\n")); // hues rotate
		expect(shifted.map(l => Bun.stripANSI(l))).toEqual(still.map(l => Bun.stripANSI(l)));
	});

	it("leaves tips without the marker untouched", () => {
		const lines = renderWelcomeTip("Plain old tip", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		expect(plain).not.toContain("NEW!");
		expect(plain).toContain("Tip: Plain old tip");
	});

	it("derives label and body colors from the active theme, with no manual dim layer", async () => {
		// Regression for #3337: hardcoded #b48cff/#9ccfff plus a manual `\x1b[2m`
		// dropped the body to ~1.5:1 contrast on any light-theme background.
		await setTheme("dark");
		const darkLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const darkMutedAnsi = theme.getFgAnsi("muted");
		const dark = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		await setTheme("light");
		const lightLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const lightMutedAnsi = theme.getFgAnsi("muted");
		const light = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		// Each theme paints with its own tokens.
		expect(dark).toContain(darkLabelAnsi);
		expect(dark).toContain(darkMutedAnsi);
		expect(light).toContain(lightLabelAnsi);
		expect(light).toContain(lightMutedAnsi);

		// Switching themes must change the emitted bytes — the previous bug
		// produced byte-identical output for both.
		expect(dark).not.toBe(light);

		// The manual `\x1b[2m` dim is gone; muted/label tokens carry their own
		// theme-tuned luminance.
		expect(dark).not.toContain("\x1b[2m");
		expect(light).not.toContain("\x1b[2m");
	});
});
