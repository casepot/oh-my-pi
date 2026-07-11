import type { AgentRegistry, RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { IrcMessage } from "../bus";

export interface IrcObserverSessionIdentity {
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly rootSessionLabel?: string;
}

interface TopLevelBinding {
	readonly session: AgentSession;
}

export class IrcObserverSessionIndex {
	readonly #registry: AgentRegistry;
	readonly #topLevels = new Map<string, TopLevelBinding>();
	readonly #descendants = new Map<string, IrcObserverSessionIdentity>();
	readonly #unsubscribe: () => void;

	constructor(registry: AgentRegistry) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryChange(event));
	}

	bindTopLevel(agentId: string, session: AgentSession): void {
		this.#topLevels.set(agentId, { session });
		this.#hydrateUnresolvedDescendants();
	}

	resolveRootSession(agentId: string): IrcObserverSessionIdentity | undefined {
		const binding = this.#topLevels.get(agentId);
		if (binding) return this.#readTopLevel(agentId, binding);
		return this.#descendants.get(agentId);
	}

	resolveMessageSession(message: Pick<IrcMessage, "from" | "to">): IrcObserverSessionIdentity | undefined {
		if (!this.#registry.get(message.from)) return undefined;
		const sender = this.resolveRootSession(message.from);
		if (!sender) return undefined;
		if (this.#topLevels.has(message.from) && message.to !== message.from) {
			const target = this.#descendants.get(message.to);
			if (target?.rootAgentId === message.from) return target;
		}
		return sender;
	}

	dispose(): void {
		this.#unsubscribe();
		this.#topLevels.clear();
		this.#descendants.clear();
	}

	#readTopLevel(agentId: string, binding: TopLevelBinding): IrcObserverSessionIdentity {
		const rootSessionLabel = binding.session.sessionManager.getSessionName();
		return {
			rootAgentId: agentId,
			rootSessionId: binding.session.sessionManager.getSessionId(),
			...(rootSessionLabel ? { rootSessionLabel } : {}),
		};
	}

	#onRegistryChange(event: RegistryEvent): void {
		if (event.type !== "registered") return;
		if (this.#topLevels.has(event.ref.id)) return;
		this.#descendants.delete(event.ref.id);
		const identity = this.#identityFromParent(event.ref.parentId);
		if (identity) this.#descendants.set(event.ref.id, identity);
	}

	#identityFromParent(parentId: string | undefined): IrcObserverSessionIdentity | undefined {
		if (!parentId) return undefined;
		const topLevel = this.#topLevels.get(parentId);
		if (topLevel) return Object.freeze({ ...this.#readTopLevel(parentId, topLevel) });
		return this.#descendants.get(parentId);
	}

	#hydrateUnresolvedDescendants(): void {
		let changed = true;
		while (changed) {
			changed = false;
			for (const ref of this.#registry.list()) {
				if (this.#topLevels.has(ref.id) || this.#descendants.has(ref.id)) continue;
				const identity = this.#identityFromParent(ref.parentId);
				if (!identity) continue;
				this.#descendants.set(ref.id, identity);
				changed = true;
			}
		}
	}
}
