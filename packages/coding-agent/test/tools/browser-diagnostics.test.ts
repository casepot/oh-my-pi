import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	BrowserTool,
	type BrowserToolDetails,
	classifyBrowserRecovery,
	localTabStaleRiskHint,
} from "@oh-my-pi/pi-coding-agent/tools/browser";
import { browserToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/browser/render";

function createSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "browser.cmux": false, "browser.headless": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("browser diagnostics", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("classifies attached-target misses as actionable app.target recovery", () => {
		const recovery = classifyBrowserRecovery(new Error('No page target matched "missing". Available pages:'), {
			phase: "acquire-tab",
			name: "main",
		});

		expect(recovery.kind).toBe("target-not-found");
		expect(recovery.summary).toBe("No attached page matched app.target.");
		expect(recovery.nextAction).toContain("Retry without app.target");
	});

	it("classifies local navigation failures as local server recovery", () => {
		const recovery = classifyBrowserRecovery(new Error("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5190/"), {
			phase: "acquire-tab",
			name: "main",
			url: "http://127.0.0.1:5190/",
		});

		expect(recovery.kind).toBe("local-url-unreachable");
		expect(recovery.summary).toBe("Requested local URL did not respond.");
		expect(recovery.nextAction).toContain("http://127.0.0.1:5190");
		expect(recovery.nextAction).toContain("strict port");
		expect(recovery.nextAction).toContain("close/reopen the named browser tab");
	});

	it("does not warn stale-tab risk for non-local URLs", () => {
		const recovery = localTabStaleRiskHint({
			name: "main",
			requestedUrl: "https://example.com/",
			finalUrl: "https://example.com/",
			reused: true,
		});

		expect(recovery).toBeUndefined();
	});

	it("warns when reusing a local browser tab", () => {
		const recovery = localTabStaleRiskHint({
			name: "main",
			requestedUrl: "http://127.0.0.1:5173/",
			finalUrl: "http://127.0.0.1:5173/",
			reused: true,
		});

		expect(recovery?.kind).toBe("local-tab-stale-risk");
		expect(recovery?.summary).toBe("Local browser tab may be showing stale dev-server content.");
		expect(recovery?.nextAction).toContain('browser({ action: "close", name: "main" })');
		expect(recovery?.nextAction).toContain("strict port");
	});

	it("warns when local requested and final origins differ", () => {
		const recovery = localTabStaleRiskHint({
			name: "preview",
			requestedUrl: "http://localhost:5173/",
			finalUrl: "http://127.0.0.1:4173/",
			reused: false,
		});

		expect(recovery?.kind).toBe("local-tab-stale-risk");
		expect(recovery?.nextAction).toContain('browser({ action: "close", name: "preview" })');
	});

	it("returns classified error details for invalid CDP open requests", async () => {
		const tool = new BrowserTool(createSession());

		const result = await tool.execute("bad-cdp", {
			action: "open",
			name: "bad-cdp",
			app: { cdp_url: "ws://127.0.0.1:9222/devtools/browser/id" },
		});

		expect(result.isError).toBe(true);
		expect(result.details?.recovery?.kind).toBe("invalid-argument");
		const text = result.content.find(content => content.type === "text")?.text ?? "";
		expect(text).toContain("HTTP CDP discovery endpoint");
		expect(text).toContain("Next:");
	});

	it("renders browser recovery guidance from result details", () => {
		const details: BrowserToolDetails = {
			action: "open",
			name: "main",
			browser: "connected",
			recovery: {
				kind: "cdp-unavailable",
				summary: "CDP endpoint could not be reached or attached.",
				nextAction: "Start the app with remote debugging enabled, verify the HTTP cdp_url, then retry.",
			},
		};
		const rendered = Bun.stripANSI(
			browserToolRenderer
				.renderResult(
					{
						content: [
							{
								type: "text",
								text: "Browser open failed: refused\nRecovery: CDP endpoint could not be reached or attached.\nNext: Start the app with remote debugging enabled, verify the HTTP cdp_url, then retry.",
							},
						],
						details,
						isError: true,
					},
					{ expanded: true, isPartial: false },
					theme,
					{ action: "open", name: "main", app: { cdp_url: "http://127.0.0.1:9222" } },
				)
				.render(120)
				.join("\n"),
		);

		expect(rendered).toContain("Recovery: CDP endpoint could not be reached or attached.");
		expect(rendered).toContain("Next: Start the app with remote debugging enabled");
	});

	it("renders browser recovery guidance on successful local opens", () => {
		const details: BrowserToolDetails = {
			action: "open",
			name: "main",
			browser: "headless",
			url: "http://127.0.0.1:5173/",
			recovery: {
				kind: "local-tab-stale-risk",
				summary: "Local browser tab may be showing stale dev-server content.",
				nextAction:
					'If the page title/content does not match this run, call browser({ action: "close", name: "main" }), verify the dev server process and strict port, then reopen the requested URL.',
			},
		};
		const rendered = Bun.stripANSI(
			browserToolRenderer
				.renderResult(
					{
						content: [
							{
								type: "text",
								text: 'Reused tab "main" on headless browser\nURL: http://127.0.0.1:5173/\nRecovery: Local browser tab may be showing stale dev-server content.\nNext: If the page title/content does not match this run, call browser({ action: "close", name: "main" }), verify the dev server process and strict port, then reopen the requested URL.',
							},
						],
						details,
						isError: false,
					},
					{ expanded: true, isPartial: false },
					theme,
					{ action: "open", name: "main", url: "http://127.0.0.1:5173/" },
				)
				.render(160)
				.join("\n"),
		);

		expect(rendered).toContain("Recovery: Local browser tab may be showing stale dev-server content.");
		expect(rendered).toContain(
			'Next: If the page title/content does not match this run, call browser({ action: "close", name: "main" })',
		);
	});
});
