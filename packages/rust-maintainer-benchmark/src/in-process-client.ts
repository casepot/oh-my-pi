import type { AgentEvent, AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent, AuthStorage, SessionStats } from "@oh-my-pi/pi-coding-agent";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";

export type InProcessEventListener = (event: AgentEvent) => void;

export interface InProcessClientOptions {
	cwd: string;
	model: string;
	appendSystemPrompt?: string;
	tools?: string[];
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	shared?: SharedInfra;
}

export interface SharedInfra {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

export interface DiscoverSharedInfraOptions {
	cwd?: string;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
}

export function createBenchmarkSettingsOverrides(options: DiscoverSharedInfraOptions = {}): Record<string, unknown> {
	const overrides: Record<string, unknown> = {
		"memory.backend": "off",
		"memories.enabled": false,
		"autolearn.enabled": false,
	};
	if (options.editVariant && options.editVariant !== "auto") {
		overrides["edit.mode"] = options.editVariant;
	}
	if (options.editFuzzy !== undefined && options.editFuzzy !== "auto") {
		overrides["edit.fuzzyMatch"] = options.editFuzzy;
	}
	if (options.editFuzzyThreshold !== undefined && options.editFuzzyThreshold !== "auto") {
		overrides["edit.fuzzyThreshold"] = options.editFuzzyThreshold;
	}
	return overrides;
}

export async function discoverSharedInfra(options: DiscoverSharedInfraOptions = {}): Promise<SharedInfra> {
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const overrides = createBenchmarkSettingsOverrides(options);
		await Settings.init({ cwd: options.cwd, overrides });

		return { authStorage, modelRegistry };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

export class InProcessClient {
	#session: AgentSession | null = null;
	#sessionResult: CreateAgentSessionResult | null = null;
	#eventListeners: InProcessEventListener[] = [];
	#unsubscribe: (() => void) | null = null;
	#options: InProcessClientOptions;

	constructor(options: InProcessClientOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		const shared = this.#options.shared;

		const settings = Settings.isolated(
			createBenchmarkSettingsOverrides({
				editVariant: this.#options.editVariant,
				editFuzzy: this.#options.editFuzzy,
				editFuzzyThreshold: this.#options.editFuzzyThreshold,
			}),
		);

		const result = await createAgentSession({
			cwd: this.#options.cwd,
			modelPattern: this.#options.model,
			authStorage: shared?.authStorage,
			modelRegistry: shared?.modelRegistry,
			sessionManager: SessionManager.inMemory(this.#options.cwd),
			settings,
			systemPrompt: this.#options.appendSystemPrompt
				? (defaultPrompt: string[]) => [...defaultPrompt, this.#options.appendSystemPrompt!]
				: undefined,
			toolNames: this.#options.tools ?? ["read", "edit", "write"],
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		});

		this.#sessionResult = result;
		this.#session = result.session;
		this.#unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			if (isAgentEvent(event)) {
				for (const listener of this.#eventListeners) listener(event);
			}
		});
	}

	async setThinkingLevel(level: ResolvedThinkingLevel): Promise<void> {
		this.#session!.setThinkingLevel(level);
	}

	onEvent(listener: InProcessEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) this.#eventListeners.splice(index, 1);
		};
	}

	async prompt(text: string): Promise<void> {
		await this.#session!.prompt(text, { expandPromptTemplates: false });
		await this.#session!.waitForIdle();
	}

	async followUp(text: string): Promise<void> {
		await this.#session!.followUp(text);
		await this.#session!.waitForIdle();
	}

	abort(): void {
		this.#session?.abort();
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.#session!.getSessionStats();
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#session!.getLastAssistantText() ?? null;
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.#session!.messages;
	}

	async getState(): Promise<{
		sessionFile?: string;
		systemPrompt?: string[];
		model?: Model;
		thinkingLevel?: ThinkingLevel | undefined;
		dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	}> {
		const session = this.#session!;
		return {
			sessionFile: undefined,
			systemPrompt: session.systemPrompt,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			dumpTools: session.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				examples: tool.examples,
			})),
		};
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#session) {
			await this.#session.dispose();
			this.#session = null;
		}
		const mcpManager = this.#sessionResult?.mcpManager;
		if (mcpManager && typeof mcpManager === "object" && "dispose" in mcpManager) {
			const dispose = mcpManager.dispose;
			if (typeof dispose === "function") await dispose.call(mcpManager);
		}
		this.#sessionResult = null;
		this.#eventListeners = [];
	}

	[Symbol.dispose](): void {
		this.dispose().catch(() => {});
	}
}

const AGENT_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
};

function isAgentEvent(event: AgentSessionEvent): event is AgentEvent {
	return event.type in AGENT_EVENT_TYPES;
}
