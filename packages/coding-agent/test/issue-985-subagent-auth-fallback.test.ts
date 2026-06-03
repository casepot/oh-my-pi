import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { kNoAuth, type ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	classifyProviderFailure,
	formatProviderFailure,
	type ProviderFailureCategory,
} from "@oh-my-pi/pi-coding-agent/utils/provider-error-classifier";

/**
 * Regression coverage for the opt-in parent-model auth fallback introduced
 * after #985.
 *
 * Reporter screenshot showed parent session on DeepSeek V4 Pro dispatching a
 * task subagent that resolved to `qwen3.6-plus-free` — an opencode-zen model
 * the user has no working credentials for. The strict default is now a visible
 * dispatch error; this helper remains for configurations that explicitly allow
 * parent-model substitution.
 */

const parentModel: Model<Api> = {
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const unauthedTaskModel: Model<Api> = {
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const sharedModel: Model<Api> = {
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
	} as unknown as ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> };
}

describe("issue #985: subagent dispatch auth fallback", () => {
	test("falls back to parent active model when resolved subagent model has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});

	test("does not fall back when resolved subagent model has working auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek", "opencode-zen"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when parent active model also has no auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns primary unchanged when no parent active model is provided", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], undefined, registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
	});

	test("does not fall back when subagent and parent resolve to the same model", async () => {
		const registry = createMockRegistry({
			models: [sharedModel],
			authedProviders: new Set(), // even with no auth, identical model means no benefit
		});

		const result = await resolveModelOverrideWithAuthFallback(["deepseek/shared-id"], "deepseek/shared-id", registry);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.id).toBe("shared-id");
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials. The helper treats this as authenticated so an explicitly
		// configured local model is never silently rerouted to the parent's
		// remote provider (see #1008).
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			registry,
		);

		expect(result.authFallbackUsed).toBe(false);
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("resolves explicit all-model candidates without wrapping private-field registries", async () => {
		class PrivateFieldRegistry {
			#models = [parentModel, unauthedTaskModel];
			canonicalCalls = 0;

			getAvailable(): Model<Api>[] {
				return [];
			}

			async getApiKey(model: Model<Api>): Promise<string | undefined> {
				return model.provider === "deepseek" ? "sk-test-token" : undefined;
			}

			resolveCanonicalModel(canonicalId: string, options?: { candidates?: Model<Api>[] }): Model<Api> | undefined {
				this.canonicalCalls += 1;
				const fallbackModels = this.#models;
				const candidates = options?.candidates ?? fallbackModels;
				return candidates.find(model => model.id === canonicalId);
			}
		}

		const registry = new PrivateFieldRegistry();
		const typedRegistry = registry as unknown as ModelLookupRegistry & {
			getApiKey(model: Model<Api>): Promise<string | undefined>;
		};
		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			"deepseek/deepseek-v4-pro",
			typedRegistry,
			undefined,
			[parentModel, unauthedTaskModel],
		);

		expect(registry.canonicalCalls).toBeGreaterThan(0);
		expect(result.authFallbackUsed).toBe(true);
		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});

	test("runSubprocess preflights missing configured subagent models", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.fallbackToParentModelOnAuthFailure": false,
		});
		const registry = {
			authStorage: {},
			getAvailable: () => [],
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as ModelRegistry;
		const agent: AgentDefinition = {
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review.",
			source: "bundled",
			model: ["missing/model"],
		};

		const result = await runSubprocess({
			cwd: process.cwd(),
			agent,
			task: "review",
			index: 0,
			id: "MissingModel",
			modelOverride: ["missing/model"],
			modelRegistry: registry,
			settings,
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("model_not_found");
		expect(result.error).toContain("Update the configured model id/role");
	});

	test("runSubprocess keeps strict default for unauthenticated configured subagent models", async () => {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		});
		const registry = {
			authStorage: {},
			getAvailable: () => [unauthedTaskModel],
			getAll: () => [unauthedTaskModel],
			getApiKey: async () => undefined,
		} as unknown as ModelRegistry;
		const agent: AgentDefinition = {
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review.",
			source: "bundled",
			model: ["qwen3.6-plus-free"],
		};

		const result = await runSubprocess({
			cwd: process.cwd(),
			agent,
			task: "review",
			index: 0,
			id: "MissingAuth",
			modelOverride: ["qwen3.6-plus-free"],
			modelRegistry: registry,
			settings,
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("auth");
		expect(result.error).toContain("no working credentials");
		expect(result.error).toContain("task.fallbackToParentModelOnAuthFailure=true");
	});

	test("provider failure classifier emits actionable representative categories", () => {
		const cases: Array<{ message: string; category: ProviderFailureCategory }> = [
			{ message: "401 unauthorized: no api key configured", category: "auth" },
			{ message: "model_not_found: model does not exist", category: "model_not_found" },
			{ message: "429 too many requests: rate limit exceeded", category: "rate_limit" },
			{ message: "maximum context length exceeded: too many tokens", category: "context_overflow" },
			{ message: "stream stalled while waiting for the next event", category: "stream_stall" },
			{ message: "timed out while waiting for the first provider event", category: "first_event_timeout" },
			{ message: "Was there a typo in the url or port?", category: "network" },
		];

		for (const entry of cases) {
			const failure = classifyProviderFailure(entry.message);
			const formatted = formatProviderFailure("Subagent provider failure", failure);
			expect(failure.category).toBe(entry.category);
			expect(failure.action.length).toBeGreaterThan(0);
			expect(formatted).toContain(`[${entry.category}]`);
			expect(formatted).toContain("Action:");
		}
	});
});
