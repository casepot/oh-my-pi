import { Snowflake } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter, isReservedInternalUrlScheme } from "../../internal-urls";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "../../internal-urls/types";
import { RPC_LIMITS, RpcProtocolError, rpcErrorInfo } from "./rpc-protocol";
import type {
	JsonObject,
	RpcHostUriCancelAck,
	RpcHostUriCancelRequest,
	RpcHostUriRange,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
} from "./rpc-types";

type RpcHostUriOutput = (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

type PendingUriRequest = {
	operation: "read" | "write";
	url: string;
	definition: RpcHostUriSchemeDefinition;
	resolve: (frame: RpcHostUriResult) => void;
	reject: (error: Error) => void;
	timeout?: NodeJS.Timeout;
	settled: boolean;
};

export function isRpcHostUriResult(value: unknown): value is RpcHostUriResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown };
	return frame.type === "host_uri_result" && typeof frame.id === "string";
}

function parseRangeParam(url: string): RpcHostUriRange | undefined {
	const raw = new URL(url).searchParams.get("range");
	if (raw === null || raw === "") return undefined;
	const match = /^(\d+)(?:-(\d+)?)?$/.exec(raw);
	if (!match) {
		throw new RpcProtocolError("invalid_arguments", `Invalid host URI range: ${raw}`, { range: raw });
	}
	const start = Number.parseInt(match[1]!, 10);
	const end = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
	if (end !== undefined && end < start) {
		throw new RpcProtocolError("invalid_arguments", `Invalid host URI range: ${raw}`, { range: raw });
	}
	return { start, end, unit: "byte" };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function optionalPositiveInteger(value: unknown, field: string, owner: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	throw new RpcProtocolError("invalid_arguments", `${owner} ${field} must be a positive safe integer`, { field });
}

class RpcHostUriProtocolHandler implements ProtocolHandler {
	readonly scheme: string;
	readonly immutable: boolean;
	readonly write?: (url: InternalUrl, content: string, context?: WriteContext) => Promise<void>;
	readonly #bridge: RpcHostUriBridge;

	constructor(definition: RpcHostUriSchemeDefinition, bridge: RpcHostUriBridge) {
		this.scheme = definition.scheme;
		this.immutable = definition.immutable === true;
		this.#bridge = bridge;
		if (definition.writable === true) {
			this.write = (url, content, context) => this.#bridge.requestWrite(this.scheme, url, content, context);
		}
	}

	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		return this.#bridge.requestRead(this.scheme, url, context);
	}
}

export class RpcHostUriBridge {
	#output: RpcHostUriOutput;
	#router: InternalUrlRouter;
	#definitions = new Map<string, RpcHostUriSchemeDefinition>();
	#pending = new Map<string, PendingUriRequest>();
	#pendingCancels = new Map<string, string>();

	constructor(output: RpcHostUriOutput, router: InternalUrlRouter = InternalUrlRouter.instance()) {
		this.#output = output;
		this.#router = router;
	}

	getSchemes(): string[] {
		return Array.from(this.#definitions.keys());
	}

	getDefinitions(): RpcHostUriSchemeDefinition[] {
		return Array.from(this.#definitions.values());
	}

	setSchemes(schemes: RpcHostUriSchemeDefinition[], options?: { privilegedOverride?: boolean }): string[] {
		const normalized = this.#normalizeSchemes(schemes, options);
		for (const previous of this.#definitions.keys()) {
			if (!normalized.has(previous)) {
				this.#router.unregister(previous);
			}
		}
		for (const definition of normalized.values()) {
			this.#router.register(new RpcHostUriProtocolHandler(definition, this));
		}
		this.#definitions = normalized;
		return Array.from(normalized.keys());
	}

	addSchemes(schemes: RpcHostUriSchemeDefinition[], options?: { privilegedOverride?: boolean }): string[] {
		const normalized = this.#normalizeSchemes(schemes, options);
		for (const definition of normalized.values()) {
			this.#definitions.set(definition.scheme, definition);
			this.#router.register(new RpcHostUriProtocolHandler(definition, this));
		}
		return this.getSchemes();
	}

	removeSchemes(schemes: string[]): string[] {
		for (const raw of schemes) {
			const scheme = raw.trim().toLowerCase();
			if (!scheme || isReservedInternalUrlScheme(scheme)) continue;
			if (this.#definitions.delete(scheme)) {
				this.#router.unregister(scheme);
			}
		}
		return this.getSchemes();
	}

	clear(message: string = "Host URI bridge shut down"): void {
		for (const scheme of this.#definitions.keys()) {
			this.#router.unregister(scheme);
		}
		this.#definitions.clear();
		this.rejectAllPending(message);
	}

	handleResult(frame: RpcHostUriResult): boolean {
		const pending = this.#pending.get(frame.id);
		if (!pending) return false;
		if (frame.content !== undefined && typeof frame.content !== "string") {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError("invalid_frame", `Host URI ${pending.operation} content must be a string`, {
					url: pending.url,
				}),
			);
			return true;
		}
		if (frame.bytesBase64 !== undefined && typeof frame.bytesBase64 !== "string") {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError("invalid_frame", `Host URI ${pending.operation} bytesBase64 must be a string`, {
					url: pending.url,
				}),
			);
			return true;
		}
		if (frame.contentLength !== undefined && !Number.isSafeInteger(frame.contentLength)) {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError("invalid_frame", `Host URI ${pending.operation} contentLength must be an integer`, {
					url: pending.url,
				}),
			);
			return true;
		}
		const content = frame.content ?? "";
		const encoded = frame.bytesBase64 ?? "";
		let decodedBytes = 0;
		if (encoded) {
			decodedBytes = Buffer.from(encoded, "base64").byteLength;
		}
		const actualBytes = byteLength(content) + decodedBytes;
		const declaredBytes = frame.contentLength;
		if (declaredBytes !== undefined && declaredBytes !== actualBytes) {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError(
					"host_uri_too_large",
					`Host URI ${pending.operation} content length did not match payload`,
					{
						url: pending.url,
						declaredBytes,
						actualBytes,
					},
				),
			);
			return true;
		}
		if (actualBytes > this.#maxContentBytes(pending.definition)) {
			this.#rejectPending(
				frame.id,
				new RpcProtocolError("host_uri_too_large", `Host URI ${pending.operation} exceeded size limit`, {
					url: pending.url,
					limitBytes: this.#maxContentBytes(pending.definition),
					actualBytes,
				}),
			);
			return true;
		}
		this.#pending.delete(frame.id);
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.settled = true;
		pending.resolve(frame);
		return true;
	}

	handleCancelAck(frame: RpcHostUriCancelAck): boolean {
		return this.#pendingCancels.delete(frame.id);
	}

	rejectAllPending(message: string): void {
		const pendingIds = Array.from(this.#pending.keys());
		for (const id of pendingIds) {
			this.#rejectPending(id, new RpcProtocolError("peer_closed", message, undefined, true));
		}
		this.#pendingCancels.clear();
	}

	async requestRead(scheme: string, url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const definition = this.#definitions.get(scheme);
		if (!definition) {
			throw new RpcProtocolError("host_uri_scheme_not_found", `Host URI scheme is not registered: ${scheme}`);
		}
		const requestedRange = this.#resolveRange(definition, url.href, context?.range);
		const result = await this.#dispatch(definition, "read", url.href, undefined, context?.signal, requestedRange);
		if (result.isError) {
			const info =
				result.errorInfo ??
				rpcErrorInfo("host_uri_denied", result.error || result.content || `Host URI read failed for ${url.href}`);
			throw new RpcProtocolError(info.code, info.message, info.details, info.retryable);
		}
		const content =
			result.content ?? (result.bytesBase64 ? Buffer.from(result.bytesBase64, "base64").toString("utf8") : "");
		const contentType = (result.contentType ?? "text/plain") as InternalResource["contentType"];
		return {
			url: url.href,
			content,
			contentType,
			size: result.contentLength ?? byteLength(content),
			notes: result.notes && result.notes.length > 0 ? [...result.notes] : undefined,
			immutable: result.immutable ?? definition.immutable === true,
			rangeApplied: requestedRange !== undefined,
		};
	}

	async requestWrite(scheme: string, url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const definition = this.#definitions.get(scheme);
		if (!definition) {
			throw new RpcProtocolError("host_uri_scheme_not_found", `Host URI scheme is not registered: ${scheme}`);
		}
		if (byteLength(content) > this.#maxContentBytes(definition)) {
			throw new RpcProtocolError("host_uri_too_large", `Host URI write exceeded size limit`, {
				url: url.href,
				limitBytes: this.#maxContentBytes(definition),
			});
		}
		const result = await this.#dispatch(definition, "write", url.href, content, context?.signal);
		if (result.isError) {
			const info =
				result.errorInfo ??
				rpcErrorInfo("host_uri_denied", result.error || result.content || `Host URI write failed for ${url.href}`);
			throw new RpcProtocolError(info.code, info.message, info.details, info.retryable);
		}
	}

	#dispatch(
		definition: RpcHostUriSchemeDefinition,
		operation: "read" | "write",
		url: string,
		content: string | undefined,
		signal: AbortSignal | undefined,
		requestedRange?: RpcHostUriRange,
	): Promise<RpcHostUriResult> {
		if (signal?.aborted) {
			return Promise.reject(
				new RpcProtocolError("operation_cancelled", `Host URI ${operation} for ${url} was aborted`),
			);
		}

		const id = Snowflake.next() as string;
		const timeoutMs = definition.defaultTimeoutMs ?? RPC_LIMITS.defaultHostUriTimeoutMs;
		const frame: RpcHostUriRequest = {
			type: "host_uri_request",
			id,
			operation,
			url,
			deadlineMs: timeoutMs ?? undefined,
			maxContentBytes: this.#maxInlineContentBytes(definition),
			acceptsBase64: definition.binary === true,
			range: requestedRange,
		};
		if (operation === "write") {
			frame.content = content ?? "";
			frame.contentLength = byteLength(frame.content);
		}
		if (Buffer.byteLength(JSON.stringify(frame), "utf8") > RPC_LIMITS.maxOutboundFrameBytes - 16_384) {
			return Promise.reject(
				new RpcProtocolError("host_uri_too_large", `Host URI ${operation} request exceeded size limit`, {
					url,
					limitBytes: RPC_LIMITS.maxOutboundFrameBytes,
				}),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<RpcHostUriResult>();
		const pending: PendingUriRequest = {
			operation,
			url,
			definition,
			resolve,
			reject,
			settled: false,
		};
		if (timeoutMs && timeoutMs > 0) {
			pending.timeout = setTimeout(() => {
				this.#rejectPending(
					id,
					new RpcProtocolError("host_uri_denied", `Host URI ${operation} timed out`, { url, timeoutMs }, true),
				);
			}, timeoutMs);
			pending.timeout.unref();
		}

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
			if (pending.timeout) clearTimeout(pending.timeout);
		};

		const onAbort = () => {
			if (pending.settled) return;
			pending.settled = true;
			const info = rpcErrorInfo("operation_cancelled", `Host URI ${operation} for ${url} was aborted`);
			const cancelId = Snowflake.next() as string;
			this.#pendingCancels.set(cancelId, id);
			this.#output({
				type: "host_uri_cancel",
				id: cancelId,
				targetId: id,
				expectsAck: true,
				errorInfo: info,
			});
			cleanup();
			reject(new RpcProtocolError(info.code, info.message, info.details, info.retryable));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, pending);
		this.#output(frame);

		return promise.finally(cleanup);
	}

	#resolveRange(
		definition: RpcHostUriSchemeDefinition,
		url: string,
		contextRange: RpcHostUriRange | undefined,
	): RpcHostUriRange | undefined {
		const requestedRange = contextRange ?? parseRangeParam(url);
		if (!requestedRange) return undefined;
		if (definition.range !== true) {
			throw new RpcProtocolError(
				"host_uri_denied",
				`Host URI scheme does not support ranged reads: ${definition.scheme}`,
				{
					scheme: definition.scheme,
					range: requestedRange as unknown as JsonObject,
				},
			);
		}
		return requestedRange;
	}

	#normalizeSchemes(
		schemes: RpcHostUriSchemeDefinition[],
		options?: { privilegedOverride?: boolean },
	): Map<string, RpcHostUriSchemeDefinition> {
		const normalized = new Map<string, RpcHostUriSchemeDefinition>();
		for (const raw of schemes) {
			const scheme = typeof raw?.scheme === "string" ? raw.scheme.trim().toLowerCase() : "";
			if (!scheme) {
				throw new RpcProtocolError("invalid_arguments", "Host URI scheme must be a non-empty string");
			}
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
				throw new RpcProtocolError(
					"invalid_arguments",
					`Host URI scheme contains invalid characters: ${raw.scheme}`,
				);
			}
			if (isReservedInternalUrlScheme(scheme) && options?.privilegedOverride !== true) {
				throw new RpcProtocolError("host_uri_denied", `Host URI scheme is reserved by OMP: ${scheme}`, { scheme });
			}
			normalized.set(scheme, {
				scheme,
				description: typeof raw.description === "string" ? raw.description : undefined,
				writable: raw.writable === true,
				immutable: raw.immutable === true,
				trustClass: raw.trustClass,
				defaultTimeoutMs: optionalPositiveInteger(raw.defaultTimeoutMs, "defaultTimeoutMs", `Host URI "${scheme}"`),
				maxContentBytes: optionalPositiveInteger(raw.maxContentBytes, "maxContentBytes", `Host URI "${scheme}"`),
				contentTypes: Array.isArray(raw.contentTypes) ? [...raw.contentTypes] : undefined,
				binary: raw.binary === true,
				range: raw.range === true,
			});
		}
		return normalized;
	}

	#rejectPending(id: string, error: Error): void {
		const pending = this.#pending.get(id);
		if (!pending || pending.settled) return;
		pending.settled = true;
		this.#pending.delete(id);
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.reject(error);
	}

	#maxInlineContentBytes(definition: RpcHostUriSchemeDefinition): number {
		const maxContentBytes = this.#maxContentBytes(definition);
		if (definition.binary !== true) return maxContentBytes;
		const maxEncodedPayloadBytes = RPC_LIMITS.maxOutboundFrameBytes - 32_768;
		const maxDecodedBase64Bytes = Math.floor((maxEncodedPayloadBytes * 3) / 4);
		return Math.min(maxContentBytes, maxDecodedBase64Bytes);
	}

	#maxContentBytes(definition: RpcHostUriSchemeDefinition): number {
		return definition.maxContentBytes ?? RPC_LIMITS.maxHostUriContentBytes;
	}
}
