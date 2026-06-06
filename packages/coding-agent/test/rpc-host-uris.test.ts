import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { RPC_LIMITS } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-protocol";
import type { RpcHostUriCancelRequest, RpcHostUriRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const router = InternalUrlRouter.instance();

afterEach(() => {
	// Tests register transient schemes on the global router; clean them up
	// between cases so neighboring suites observe the default registration.
	router.unregister("db");
	router.unregister("notes");
	router.unregister("Db"); // case-insensitive guard
	router.unregister("big");
	router.unregister("range");
});

function recordOutput(): {
	frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest>;
	push: (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;
} {
	const frames: Array<RpcHostUriRequest | RpcHostUriCancelRequest> = [];
	return { frames, push: frame => frames.push(frame) };
}

describe("RpcHostUriBridge", () => {
	it("registers schemes against the router and surfaces read results", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);

		bridge.setSchemes([{ scheme: "db", description: "rows", writable: false }]);
		expect(router.canHandle("db://users/42")).toBe(true);

		const pending = bridge.requestRead("db", parseInternalUrl("db://users/42"));
		expect(out.frames).toHaveLength(1);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
		expect(request.operation).toBe("read");
		expect(request.url).toBe("db://users/42");

		bridge.handleResult({
			type: "host_uri_result",
			id: request.id,
			content: "id=42",
			contentType: "application/json",
			notes: ["fresh"],
		});

		const resource = await pending;
		expect(resource.content).toBe("id=42");
		expect(resource.contentType).toBe("application/json");
		expect(resource.notes).toEqual(["fresh"]);
		bridge.clear("test cleanup");
	});

	it("attaches a write hook only for writable schemes", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([
			{ scheme: "db", writable: true },
			{ scheme: "notes", writable: false },
		]);

		const dbHandler = router.getHandler("db");
		const notesHandler = router.getHandler("notes");
		expect(typeof dbHandler?.write).toBe("function");
		expect(notesHandler?.write).toBeUndefined();

		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestWrite("db", url, "new content");
		expect(out.frames).toHaveLength(1);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
		expect(request.operation).toBe("write");
		expect(request.content).toBe("new content");

		bridge.handleResult({ type: "host_uri_result", id: request.id });
		await expect(pending).resolves.toBeUndefined();
		bridge.clear("test cleanup");
	});

	it("propagates host-reported errors as exceptions", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "db", writable: true }]);

		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestRead("db", url);
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") {
			throw new Error("Expected host_uri_request frame");
		}
		bridge.handleResult({
			type: "host_uri_result",
			id: request.id,
			isError: true,
			error: "row not found",
		});

		await expect(pending).rejects.toThrow("row not found");
		bridge.clear("test cleanup");
	});

	it("emits a cancel frame when the read signal aborts", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "db" }]);

		const controller = new AbortController();
		const url = parseInternalUrl("db://users/42");
		const pending = bridge.requestRead("db", url, { signal: controller.signal });
		expect(out.frames).toHaveLength(1);

		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		const cancel = out.frames[1];
		expect(cancel?.type).toBe("host_uri_cancel");
		bridge.clear("test cleanup");
	});

	it("normalizes scheme casing and rejects invalid characters", () => {
		const bridge = new RpcHostUriBridge(() => {});
		const accepted = bridge.setSchemes([{ scheme: "  DB  " }]);
		expect(accepted).toEqual(["db"]);
		expect(router.canHandle("db://x")).toBe(true);

		expect(() => bridge.setSchemes([{ scheme: "1bad" }])).toThrow();
		bridge.clear("test cleanup");
	});

	it("replaces the registered set and unregisters schemes that drop off", () => {
		const bridge = new RpcHostUriBridge(() => {});
		bridge.setSchemes([{ scheme: "db" }, { scheme: "notes" }]);
		expect(router.canHandle("notes://idx")).toBe(true);

		bridge.setSchemes([{ scheme: "db" }]);
		expect(router.canHandle("notes://idx")).toBe(false);
		expect(router.canHandle("db://idx")).toBe(true);
		bridge.clear("test cleanup");
	});

	it("adds and removes schemes incrementally without clearing built-ins", () => {
		const artifactHandlerBefore = router.getHandler("artifact");
		const bridge = new RpcHostUriBridge(() => {});
		expect(() => bridge.setSchemes([{ scheme: "artifact" }])).toThrow(/reserved/);
		expect(router.getHandler("artifact")).toBe(artifactHandlerBefore);

		bridge.setSchemes([{ scheme: "db" }]);
		bridge.addSchemes([{ scheme: "notes" }]);
		expect(bridge.getSchemes()).toEqual(["db", "notes"]);
		expect(router.canHandle("db://idx")).toBe(true);
		expect(router.canHandle("notes://idx")).toBe(true);

		bridge.removeSchemes(["db", "artifact"]);
		expect(bridge.getSchemes()).toEqual(["notes"]);
		expect(router.canHandle("db://idx")).toBe(false);
		expect(router.getHandler("artifact")).toBe(artifactHandlerBefore);

		bridge.clear("test cleanup");
		expect(router.getHandler("artifact")).toBe(artifactHandlerBefore);
	});

	it("rejects oversized reads and writes with bounded typed errors", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "big", writable: true, maxContentBytes: 16 }]);

		const read = bridge.requestRead("big", parseInternalUrl("big://blob"));
		const readRequest = out.frames[0];
		if (readRequest?.type !== "host_uri_request") throw new Error("Expected host_uri_request frame");
		bridge.handleResult({
			type: "host_uri_result",
			id: readRequest.id,
			content: "x".repeat(128),
			contentLength: 128,
		});
		await expect(read).rejects.toMatchObject({ errorInfo: { code: "host_uri_too_large" } });

		const mismatched = bridge.requestRead("big", parseInternalUrl("big://mismatch"));
		const mismatchRequest = out.frames[1];
		if (mismatchRequest?.type !== "host_uri_request") throw new Error("Expected host_uri_request frame");
		bridge.handleResult({
			type: "host_uri_result",
			id: mismatchRequest.id,
			content: "x".repeat(32),
			contentLength: 1,
		});
		await expect(mismatched).rejects.toMatchObject({ errorInfo: { code: "host_uri_too_large" } });

		await expect(bridge.requestWrite("big", parseInternalUrl("big://blob"), "x".repeat(128))).rejects.toMatchObject({
			errorInfo: { code: "host_uri_too_large" },
		});
		bridge.clear("test cleanup");
	});

	it("forwards range-capable reads with explicit range metadata", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "range", range: true }]);
		const read = bridge.requestRead("range", parseInternalUrl("range://blob?range=0-15"));
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") throw new Error("Expected host_uri_request frame");
		expect(request.url).toBe("range://blob?range=0-15");
		expect(request.range).toEqual({ start: 0, end: 15, unit: "byte" });
		expect(request.maxContentBytes).toBeGreaterThan(0);
		bridge.handleResult({ type: "host_uri_result", id: request.id, content: "partial", contentLength: 7 });
		await expect(read).resolves.toMatchObject({ content: "partial", rangeApplied: true });
		bridge.clear("test cleanup");
	});

	it("advertises binary URI content limits that can fit in one outbound frame", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "big", binary: true, maxContentBytes: RPC_LIMITS.maxHostUriContentBytes }]);
		const pending = bridge.requestRead("big", parseInternalUrl("big://blob"));
		const request = out.frames[0];
		if (request?.type !== "host_uri_request") throw new Error("Expected host_uri_request frame");
		expect(request.acceptsBase64).toBe(true);
		expect(request.maxContentBytes).toBeLessThan(RPC_LIMITS.maxHostUriContentBytes);
		const encodedBytes = Math.ceil(((request.maxContentBytes ?? 0) * 4) / 3);
		expect(encodedBytes).toBeLessThan(RPC_LIMITS.maxOutboundFrameBytes);
		bridge.handleResult({ type: "host_uri_result", id: request.id, bytesBase64: "", contentLength: 0 });
		await expect(pending).resolves.toMatchObject({ content: "" });
		bridge.clear("test cleanup");
	});

	it("rejects ranged reads for schemes that do not declare range support", async () => {
		const bridge = new RpcHostUriBridge(() => {});
		bridge.setSchemes([{ scheme: "db" }]);
		await expect(bridge.requestRead("db", parseInternalUrl("db://blob?range=0-15"))).rejects.toMatchObject({
			errorInfo: { code: "host_uri_denied" },
		});
		bridge.clear("test cleanup");
	});

	it("rejects oversized outbound URI requests before creating pending state", async () => {
		const out = recordOutput();
		const bridge = new RpcHostUriBridge(out.push);
		bridge.setSchemes([{ scheme: "big" }]);

		await expect(
			bridge.requestRead("big", parseInternalUrl(`big://${"x".repeat(RPC_LIMITS.maxOutboundFrameBytes)}`)),
		).rejects.toMatchObject({
			errorInfo: { code: "host_uri_too_large" },
		});
		expect(out.frames).toHaveLength(0);
		bridge.clear("test cleanup");
	});
});
