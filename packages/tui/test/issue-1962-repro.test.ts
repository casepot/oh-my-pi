import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class ArrowSelectorComponent implements Component, Focusable {
	focused = true;
	#selectedIndex = 0;

	handleInput(data: string): void {
		if (data === "\x1b[B") this.#selectedIndex = 1;
		if (data === "\x1b[A") this.#selectedIndex = 0;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.#selectedIndex === 0 ? "> first" : "  first", this.#selectedIndex === 1 ? "> second" : "  second"];
	}
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

async function settle(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

describe("issue #1962: arrow navigation after dirty scrollback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not clear and replay the whole transcript for a focused arrow-key frame", async () => {
		const term = new VirtualTerminal(40, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new MutableLinesComponent(Array.from({ length: 12 }, (_value, index) => `history-${index}`));
		const selector = new ArrowSelectorComponent();
		tui.addChild(transcript);
		tui.addChild(selector);
		tui.setFocus(selector);

		try {
			tui.start();
			await settle(scheduler, term);

			transcript.setLines([
				"history-0 updated",
				...Array.from({ length: 11 }, (_value, index) => `history-${index + 1}`),
			]);
			tui.requestRender();
			await settle(scheduler, term);

			const writes = captureWrites(term);
			term.sendInput("\x1b[B");
			await settle(scheduler, term);

			const output = writes.join("");
			expect(output.match(ERASE_SCROLLBACK) ?? []).toHaveLength(0);
			expect(output).not.toContain("history-0 updated");
			expect(term.getViewport().map(line => line.trimEnd())).toEqual([
				"history-8",
				"history-9",
				"history-10",
				"history-11",
				"  first",
				"> second",
			]);
		} finally {
			tui.stop();
		}
	});

	it("does not clear and replay the whole transcript for a focused arrow-key frame inside an overlay", async () => {
		const term = new VirtualTerminal(40, 6);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new MutableLinesComponent(Array.from({ length: 12 }, (_value, index) => `history-${index}`));
		tui.addChild(transcript);
		const selector = new ArrowSelectorComponent();
		tui.showOverlay(selector);

		try {
			tui.start();
			await settle(scheduler, term);

			transcript.setLines([
				"history-0 updated",
				...Array.from({ length: 11 }, (_value, index) => `history-${index + 1}`),
			]);
			tui.requestRender();
			await settle(scheduler, term);

			const writes = captureWrites(term);
			term.sendInput("\x1b[B");
			await settle(scheduler, term);

			const output = writes.join("");
			expect(output.match(ERASE_SCROLLBACK) ?? []).toHaveLength(0);
			expect(output).not.toContain("history-0 updated");
			expect(term.getViewport().map(line => line.trimEnd())).toContain("> second");
		} finally {
			tui.stop();
		}
	});
});
