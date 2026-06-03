import { isUsageLimitError } from "@oh-my-pi/pi-ai";

export type ProviderFailureCategory =
	| "auth"
	| "model_not_found"
	| "rate_limit"
	| "context_overflow"
	| "stream_stall"
	| "first_event_timeout"
	| "network"
	| "timeout"
	| "abort"
	| "unknown";

export interface ProviderFailureClassification {
	category: ProviderFailureCategory;
	message: string;
	action: string;
}

function messageFrom(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function classifyProviderFailure(error: unknown): ProviderFailureClassification {
	const message = messageFrom(error).trim() || "Provider request failed";
	const lower = message.toLowerCase();

	if (
		lower.includes("no api key") ||
		lower.includes("no working credentials") ||
		lower.includes("missing credentials") ||
		lower.includes("unauthorized") ||
		lower.includes("forbidden") ||
		/\b(401|403)\b/.test(lower)
	) {
		return {
			category: "auth",
			message,
			action: "Configure credentials for this provider/model or choose an authenticated model.",
		};
	}

	if (
		lower.includes("model_not_found") ||
		lower.includes("model not found") ||
		lower.includes("model-not-found") ||
		lower.includes("does not exist") ||
		(lower.includes("404") && lower.includes("model"))
	) {
		return {
			category: "model_not_found",
			message,
			action: "Update the configured model id/role or choose a model present in the registry.",
		};
	}

	if (
		isUsageLimitError(message) ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		/\b429\b/.test(lower)
	) {
		return {
			category: "rate_limit",
			message,
			action: "Wait for provider quota to recover, switch credentials, or choose another model tier.",
		};
	}

	if (
		lower.includes("context length") ||
		lower.includes("context window") ||
		lower.includes("maximum context") ||
		lower.includes("context overflow") ||
		lower.includes("too many tokens")
	) {
		return {
			category: "context_overflow",
			message,
			action: "Compact or reduce context before retrying, or choose a model with a larger context window.",
		};
	}

	if (lower.includes("first event") || lower.includes("timed out while waiting for the first")) {
		return {
			category: "first_event_timeout",
			message,
			action: "Retry or choose another provider/model; the provider stream produced no initial event.",
		};
	}

	if (lower.includes("stream stalled") || lower.includes("stalled while waiting for the next event")) {
		return {
			category: "stream_stall",
			message,
			action: "Retry or choose another provider/model; the provider stream stopped making progress.",
		};
	}

	if (
		lower.includes("typo in the url or port") ||
		lower.includes("couldn't connect") ||
		lower.includes("could not connect") ||
		lower.includes("connection refused") ||
		lower.includes("dns") ||
		lower.includes("fetch failed")
	) {
		return {
			category: "network",
			message,
			action:
				"Treat this as a provider transport failure: verify provider base URL/network reachability or choose another provider/model.",
		};
	}

	if (lower.includes("timeout") || lower.includes("timed out")) {
		return {
			category: "timeout",
			message,
			action: "Retry when the provider is healthy or choose another provider/model.",
		};
	}

	if (lower.includes("abort") || lower.includes("cancelled") || lower.includes("canceled")) {
		return {
			category: "abort",
			message,
			action: "The request was aborted by the caller or runtime cancellation.",
		};
	}

	return {
		category: "unknown",
		message,
		action: "Inspect provider logs or retry with another model if the failure persists.",
	};
}

export function formatProviderFailure(prefix: string, failure: ProviderFailureClassification): string {
	return `${prefix} [${failure.category}]: ${failure.message}\nAction: ${failure.action}`;
}
