import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runUpdateCommand } from "./update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	let originalPath: string | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		originalPath = undefined;
		if (tempDir) await fs.rm(tempDir, { force: true, recursive: true });
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ tag_name: "v999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-check-"));
		const fakeOmp = path.join(tempDir, "omp");
		await Bun.write(fakeOmp, "#!/bin/sh\nexit 0\n");
		await fs.chmod(fakeOmp, 0o755);
		originalPath = process.env.PATH;
		process.env.PATH = tempDir;

		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});
