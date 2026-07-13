import * as fs from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { coerceServiceTierByFamily, type ProviderPayload, type ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { parseGoalModeState, serializeGoalModeState } from "../goals/state";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import manualContinuePrompt from "../prompts/system/manual-continue.md" with { type: "text" };
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	isCustomMessageContent,
	normalizeCustomMessagePayload,
} from "./messages";
import {
	type CompactionEntry,
	EPHEMERAL_MODEL_CHANGE_ROLE,
	type GoalStateSnapshotRef,
	type ModeChangeEntry,
	type SessionEntry,
} from "./session-entries";

// #4470 crash artifacts had legacy frames (no shape metadata) with 17 frames,
// ~306k archive chars, and ~1.5M truncated chars. Current snapcompact frames
// carry shape metadata; only legacy archives with frame payload risk get this
// conservative LLM-payload guard, and transcript rendering remains intact.
const LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD = 16;
const LEGACY_SNAPCOMPACT_ARCHIVE_TEXT_GUARD = 250_000;
const LEGACY_SNAPCOMPACT_TRUNCATED_CHARS_GUARD = 1_000_000;

function hasLegacySnapcompactFrames(archive: snapcompact.Archive): boolean {
	return archive.frames.some(frame => frame.font === undefined && frame.variant === undefined);
}

function hasCrashRiskSnapcompactFramePayload(archive: snapcompact.Archive): boolean {
	return (
		archive.frames.length >= LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD ||
		snapcompact.frameDataBytes(archive.frames) >= snapcompact.FRAME_DATA_BYTES_BUDGET
	);
}

function hasCrashRiskSnapcompactArchiveSize(archive: snapcompact.Archive): boolean {
	return (
		archive.frames.length >= LEGACY_SNAPCOMPACT_FRAME_COUNT_GUARD ||
		archive.truncatedChars >= LEGACY_SNAPCOMPACT_TRUNCATED_CHARS_GUARD ||
		(snapcompact.archiveSourceText(archive)?.length ?? 0) >= LEGACY_SNAPCOMPACT_ARCHIVE_TEXT_GUARD
	);
}

function isCrashRiskLegacySnapcompactArchive(archive: snapcompact.Archive): boolean {
	return (
		hasLegacySnapcompactFrames(archive) &&
		hasCrashRiskSnapcompactFramePayload(archive) &&
		hasCrashRiskSnapcompactArchiveSize(archive)
	);
}

function snapcompactHistoryBlockOptions(
	archive: snapcompact.Archive,
	options: BuildSessionContextOptions | undefined,
): snapcompact.HistoryBlockOptions | undefined {
	if (options?.transcript) return undefined;
	if (isCrashRiskLegacySnapcompactArchive(archive)) return { maxFrameDataBytes: 0 };
	return { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET };
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;
	/** Configured thinking selector (`"auto"` or a concrete level) from the latest change. */
	configuredThinkingLevel?: string;
	serviceTier?: ServiceTierByFamily;
	/** Model roles: { default: "provider/modelId", small: "provider/modelId", ... } */
	models: Record<string, string>;
	/** Names of TTSR rules that have been injected this session */
	injectedTtsrRules: string[];
	/** MCP tool names selected through discovery for this session branch. */
	selectedMCPToolNames: string[];
	/** Whether this branch contains an explicit persisted MCP selection entry. */
	hasPersistedMCPToolSelection: boolean;
	/** Active mode (e.g. "plan") or "none" if no special mode is active */
	mode: string;
	/** Mode-specific data from the last mode_change entry */
	modeData?: Record<string, unknown>;
	/**
	 * Array parallel to messages, indicating which assistant turns should
	 * have their prompt-cache misses suppressed/explained (because a model,
	 * compaction, or plan-mode transition directly preceded them).
	 * Only populated in transcript mode.
	 */
	cacheMissExplainedAt?: boolean[];
}

/** Lists session model strings to try when restoring, in fallback order. */
export function getRestorableSessionModels(
	models: Readonly<Record<string, string>>,
	lastModelChangeRole: string | undefined,
): string[] {
	const defaultModel = models.default;
	if (
		!lastModelChangeRole ||
		lastModelChangeRole === "default" ||
		lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE
	) {
		return defaultModel ? [defaultModel] : [];
	}

	const roleModel = models[lastModelChangeRole];
	if (!roleModel) return defaultModel ? [defaultModel] : [];
	if (!defaultModel || roleModel === defaultModel) return [roleModel];
	return [roleModel, defaultModel];
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function isContextResetCompaction(entry: CompactionEntry): boolean {
	const details = entry.details;
	return typeof details === "object" && details !== null && "contextReset" in details && details.contextReset === true;
}

interface CompactGoalModeData {
	goalId: string;
	stateVersion: number;
	snapshotEntryId: string;
}

function readCompactGoalModeData(data: Record<string, unknown> | undefined): CompactGoalModeData | undefined {
	if (!data) return undefined;
	if (
		typeof data.goalId !== "string" ||
		typeof data.stateVersion !== "number" ||
		typeof data.snapshotEntryId !== "string"
	) {
		return undefined;
	}
	return {
		goalId: data.goalId,
		stateVersion: data.stateVersion,
		snapshotEntryId: data.snapshotEntryId,
	};
}

function readGoalStateSnapshotSidecar(
	ref: GoalStateSnapshotRef,
	options: BuildSessionContextOptions | undefined,
): Record<string, unknown> | undefined {
	if (!options?.localProtocolOptions) return undefined;
	const filePath = resolveLocalUrlToPath(ref.path, options.localProtocolOptions);
	const content = fs.readFileSync(filePath, "utf8");
	const bytes = new Blob([content]).size;
	if (bytes !== ref.bytes) {
		throw new Error(`goal state snapshot sidecar byte mismatch for ${ref.path}`);
	}
	const hash = Bun.hash(content).toString(16);
	if (hash !== ref.hash) {
		throw new Error(`goal state snapshot sidecar hash mismatch for ${ref.path}`);
	}
	const parsed: unknown = JSON.parse(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`goal state snapshot sidecar is not an object for ${ref.path}`);
	}
	const parsedRecord = parsed as Record<string, unknown>;
	return parsedRecord;
}

function readGoalStateSnapshotSource(
	entry: { state?: Record<string, unknown>; stateRef?: GoalStateSnapshotRef },
	options: BuildSessionContextOptions | undefined,
): Record<string, unknown> | undefined {
	if (entry.state) return entry.state;
	if (!entry.stateRef) return undefined;
	return readGoalStateSnapshotSidecar(entry.stateRef, options);
}

export interface BuildSessionContextOptions {
	/**
	 * Build the display transcript instead of the LLM context. By default this
	 * preserves every path entry with compactions inline; set
	 * `collapseCompactedHistory` for the live TUI surface to render only the
	 * latest compacted tail.
	 */
	transcript?: boolean;
	/** In transcript mode, elide entries replaced by the latest compaction. */
	collapseCompactedHistory?: boolean;
	/** Resolves local:// sidecars referenced by entries on this branch. */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Transcript mode only: preserve unmatched `toolCall` blocks whose IDs are
	 * currently executing. Historical unmatched calls are still stripped and
	 * marked, including during automatic/custom continuation turns that start
	 * before a new assistant message is persisted.
	 */
	keepDanglingToolCallIds?: ReadonlySet<string>;
}

const TRIMMED_AUTO_CONTINUE_PROMPT = autoContinuePrompt.trim();
const TRIMMED_MANUAL_CONTINUE_PROMPT = manualContinuePrompt.trim();

function isZeroTokenMaintenanceFailure(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	if (message.stopReason !== "error") return false;
	if (
		!message.errorMessage?.startsWith("Context maintenance failed before provider call:") &&
		!message.errorMessage?.startsWith("Context maintenance aborted before provider call")
	) {
		return false;
	}
	if (
		message.usage.input !== 0 ||
		message.usage.output !== 0 ||
		message.usage.cacheRead !== 0 ||
		message.usage.cacheWrite !== 0 ||
		message.usage.totalTokens !== 0
	) {
		return false;
	}
	for (const block of message.content) {
		if (block.type !== "text") return false;
		if (block.text.trim().length > 0) return false;
	}
	return true;
}

type TextContentInput = string | Array<{ type: string; text?: string }>;

function textContent(content: TextContentInput): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	let firstText: string | undefined;
	let textParts: string[] | undefined;
	for (const block of content) {
		if (block.type !== "text" || typeof block.text !== "string") return undefined;
		if (firstText === undefined) {
			firstText = block.text;
			continue;
		}
		if (textParts === undefined) textParts = [firstText];
		textParts.push(block.text);
	}
	return textParts === undefined ? (firstText ?? "") : textParts.join("\n");
}

function isSyntheticContinue(message: AgentMessage): boolean {
	if (message.role !== "developer") return false;
	if (message.attribution !== "agent") return false;
	const text = textContent(message.content);
	if (text === undefined) return false;
	const trimmed = text.trim();
	return trimmed === TRIMMED_AUTO_CONTINUE_PROMPT || trimmed === TRIMMED_MANUAL_CONTINUE_PROMPT;
}

function isGoalModeContextNoise(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.customType === "goal-mode-context" &&
		message.display === false &&
		message.attribution === "agent"
	);
}

function pruneContextMaintenanceNoise(messages: AgentMessage[]): void {
	let remove: Set<number> | undefined;
	for (let i = 0; i < messages.length; i++) {
		if (!isZeroTokenMaintenanceFailure(messages[i])) continue;
		remove ??= new Set<number>();
		remove.add(i);
		for (let j = i - 1; j >= 0; j--) {
			const message = messages[j];
			if (!isSyntheticContinue(message) && !isGoalModeContextNoise(message)) break;
			remove.add(j);
		}
		for (let j = i + 1; j < messages.length; j++) {
			const message = messages[j];
			if (!isSyntheticContinue(message) && !isGoalModeContextNoise(message)) break;
			remove.add(j);
		}
	}
	if (!remove) return;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (remove.has(i)) messages.splice(i, 1);
	}
}

/**
 * Display-only marker set on transcript assistant messages whose dangling
 * `toolCall` blocks were stripped (no paired result on the resolved path —
 * failed/retried turns, results on sibling branches). The TUI renders a
 * placeholder row from it so the turn's activity never silently vanishes.
 */
export interface StrippedToolCallsMarker {
	strippedToolCalls?: number;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
function snapcompactHistoryBlocksForContext(
	archive: snapcompact.Archive | undefined,
	options: BuildSessionContextOptions | undefined,
) {
	if (!archive) return undefined;
	if (options?.transcript && options.collapseCompactedHistory) return undefined;
	return snapcompact.historyBlocks(archive, snapcompactHistoryBlockOptions(archive, options));
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: BuildSessionContextOptions,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
	}

	// Walk from leaf to root, collecting path
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// Extract settings and find compaction
	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let serviceTier: ServiceTierByFamily | undefined;
	const models: Record<string, string> = {};
	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	let selectedMCPToolNames: string[] = [];
	let hasPersistedMCPToolSelection = false;
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	const goalSnapshots = new Map<
		string,
		{ entry: Extract<SessionEntry, { type: "goal_state_snapshot" }>; pathIndex: number }
	>();
	const goalUsageDeltas: Array<{ entry: Extract<SessionEntry, { type: "goal_usage_delta" }>; pathIndex: number }> = [];
	let latestGoalModeMarker: { entry: ModeChangeEntry; pathIndex: number } | undefined;
	// Track whether an explicit `model_change` with role="default" has been
	// seen on this path. Once a user (or the agent itself) records an
	// explicit default, later assistant-message inference must NOT overwrite
	// it: temporary fallbacks (retry fallback, context promotion) and
	// server-side model downgrades both produce assistant messages tagged
	// with the wrong model id, which previously clobbered the user's pick on
	// resume (issue #849).
	let hasExplicitDefaultModel = false;

	for (let pathIndex = 0; pathIndex < path.length; pathIndex++) {
		const entry = path[pathIndex];
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			// New format: { model: "provider/id", role?: string }
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// Legacy fallback: infer default model from assistant messages only
			// when no explicit `model_change` (role=default) entry has been
			// recorded yet. Newer sessions always record an explicit default
			// model_change at the start of the conversation, so this branch is
			// only used to keep pre-model_change sessions working.
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction") {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			// Collect injected TTSR rule names
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
			}
		} else if (entry.type === "mcp_tool_selection") {
			selectedMCPToolNames = [...entry.selectedToolNames];
			hasPersistedMCPToolSelection = true;
		} else if (entry.type === "goal_state_snapshot") {
			goalSnapshots.set(entry.id, { entry, pathIndex });
		} else if (entry.type === "goal_usage_delta") {
			goalUsageDeltas.push({ entry, pathIndex });
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
			if (entry.mode === "goal" || entry.mode === "goal_paused") {
				latestGoalModeMarker = { entry, pathIndex };
			}
		}
	}

	if ((mode === "goal" || mode === "goal_paused") && latestGoalModeMarker) {
		const marker = latestGoalModeMarker.entry;
		const compact = readCompactGoalModeData(marker.data);
		const snapshot = compact ? goalSnapshots.get(compact.snapshotEntryId) : undefined;
		const sourceData =
			compact && snapshot && snapshot.pathIndex < latestGoalModeMarker.pathIndex
				? readGoalStateSnapshotSource(snapshot.entry, options)
				: marker.data;
		const restored = sourceData ? parseGoalModeState(sourceData, mode === "goal") : undefined;
		if (restored && (!compact || restored.goal.id === compact.goalId)) {
			if (mode === "goal") {
				restored.enabled = true;
			} else {
				restored.enabled = false;
				if (restored.goal.status === "active" || restored.goal.status === "budget-limited") {
					restored.goal.status = "paused";
				}
			}
			for (const delta of goalUsageDeltas) {
				if (delta.pathIndex <= latestGoalModeMarker.pathIndex || delta.entry.goalId !== restored.goal.id) continue;
				restored.goal.tokensUsed = delta.entry.tokensUsed;
				restored.goal.timeUsedSeconds = delta.entry.timeUsedSeconds;
				restored.goal.updatedAt = delta.entry.updatedAt;
			}
			modeData = serializeGoalModeState(restored);
		} else {
			modeData = undefined;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);

	// Build messages and collect corresponding entries
	// When there's a compaction, we need to:
	// 1. Emit summary first (entry = compaction)
	// 2. Emit kept messages (from firstKeptEntryId up to compaction)
	// 3. Emit messages after compaction
	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] = [];
	let pendingReset = false;
	let currentMode = "none";
	let lastAssistantModel: string | undefined;

	const handleEntryResetTracking = (entry: SessionEntry) => {
		if (entry.type === "compaction") {
			pendingReset = true;
		} else if (entry.type === "model_change") {
			pendingReset = true;
		} else if (entry.type === "mode_change") {
			const isPlanTransition = (entry.mode === "plan") !== (currentMode === "plan");
			if (isPlanTransition) {
				pendingReset = true;
			}
			currentMode = entry.mode;
		}
	};

	const pushMessage = (msg: AgentMessage) => {
		messages.push(msg);
		if (!options?.transcript) return;
		if (msg.role === "assistant") {
			const currentModel = `${msg.provider}/${msg.model}`;
			const modelChanged = lastAssistantModel !== undefined && lastAssistantModel !== currentModel;
			lastAssistantModel = currentModel;
			cacheMissExplainedAt.push(pendingReset || modelChanged);
			pendingReset = false;
		} else {
			cacheMissExplainedAt.push(false);
		}
	};

	const appendMessage = (entry: SessionEntry) => {
		handleEntryResetTracking(entry);
		if (entry.type === "message") {
			if (
				!options?.transcript &&
				entry.message.role === "assistant" &&
				entry.message.retryRecovery?.status === "recovered"
			) {
				return;
			}
			pushMessage(entry.message);
		} else if (entry.type === "custom_message") {
			if (!isCustomMessageContent(entry.content)) return;
			const normalized = normalizeCustomMessagePayload(entry);
			const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
			pushMessage(
				createCustomMessage(
					normalized.customType,
					normalized.content,
					normalized.display,
					normalized.details,
					entry.timestamp,
					attribution,
					entry.includeInContext ?? true,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			pushMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (options?.transcript && !options.collapseCompactedHistory) {
		// Display transcript: every entry in chronological order. Compactions do
		// not erase prior history here — each renders inline (as a divider in the
		// TUI) at the point it fired, with any snapcompact frames re-attached so
		// the component can report them.
		for (const entry of path) {
			handleEntryResetTracking(entry);
			if (entry.type === "compaction") {
				const snapcompactArchive = snapcompact.getPreservedArchive(entry.preserveData);
				pushMessage(
					createCompactionSummaryMessage(
						entry.summary,
						entry.tokensBefore,
						entry.timestamp,
						entry.shortSummary,
						undefined,
						undefined,
						snapcompactHistoryBlocksForContext(snapcompactArchive, options),
						entry.warning,
					),
				);
			} else {
				appendMessage(entry);
			}
		}
	} else if (compaction) {
		const providerPayload: ProviderPayload | undefined = (() => {
			const candidate = compaction.preserveData?.openaiRemoteCompaction;
			if (!candidate || typeof candidate !== "object") return undefined;
			const remote = candidate as { provider?: unknown; replacementHistory?: unknown };
			if (typeof remote.provider !== "string" || remote.provider.length === 0) return undefined;
			if (!Array.isArray(remote.replacementHistory)) return undefined;
			return {
				type: "openaiResponsesHistory",
				provider: remote.provider,
				items: remote.replacementHistory as Array<Record<string, unknown>>,
			};
		})();
		const remoteReplacementHistory = providerPayload?.items;

		// Re-attach any archived snapcompact frames so the model can keep
		// reading the archived history after every context rebuild.
		const snapcompactArchive = snapcompact.getPreservedArchive(compaction.preserveData);
		const compactionSummaryMsg = createCompactionSummaryMessage(
			compaction.summary,
			compaction.tokensBefore,
			compaction.timestamp,
			compaction.shortSummary,
			providerPayload,
			undefined,
			snapcompactHistoryBlocksForContext(snapcompactArchive, options),
			compaction.warning,
		);
		// Agent context (non-transcript): summary first so the LLM sees the
		// compacted context before recent messages.
		if (!options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		// Find compaction index in path
		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		// The remote replacement payload (OpenAI remote compaction) carries the
		// kept turns for the LLM context only; it is not rendered as visible
		// messages. The collapsed display transcript must still emit the kept
		// SessionEntry rows so a remotely-compacted session keeps its recent
		// turns visible instead of showing only the summary and post-compaction.
		// Context-reset compactions intentionally do not re-emit pre-reset turns.
		if ((!remoteReplacementHistory || options?.transcript) && !isContextResetCompaction(compaction)) {
			// Emit kept messages (before compaction, starting from firstKeptEntryId)
			let foundFirstKept = false;
			for (let i = 0; i < compactionIdx; i++) {
				const entry = path[i];
				if (entry.id === compaction.firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (foundFirstKept) {
					appendMessage(entry);
				}
			}
		}

		// Display transcript: emit the summary at the chronological compaction
		// point (after kept messages, before post-compaction) so it stays in
		// the live region where Ctrl+O can expand it. Reset tracking fires
		// here so the first post-compaction assistant turn — not a kept
		// pre-compaction one — is marked as a cache miss.
		if (options?.transcript) handleEntryResetTracking(compaction);
		if (options?.transcript) {
			pushMessage(compactionSummaryMsg);
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	if (!options?.transcript) pruneContextMaintenanceNoise(messages);

	// Strip dangling tool_use blocks — a tool_use with no matching tool_result on the
	// resolved leaf→root path — from ANY assistant turn, not just the trailing one.
	// This happens whenever the leaf (or a branch point) lands such that an assistant
	// turn's tool results are off the selected path: its result children live on a
	// sibling branch, or it is the leaf itself (results are children below it). Left
	// in place, `transformMessages` fabricates one synthetic "aborted"/"No result
	// provided" result per dangling call, which render as phantom failed calls and
	// re-inject the failed batch into the model's
	// context — the rewind/restore loop.
	//
	// Stripping is necessary but not sufficient: a *modified* assistant turn that still
	// carries signed `thinking`/`redacted_thinking` is rejected by Anthropic — "thinking
	// blocks in the latest assistant message cannot be modified", and signed thinking
	// replayed out of its original turn shape can also fail signature validation (this
	// bites the handoff/branch-summary request). So when we rewrite a turn we also
	// neutralize its protected reasoning: drop `redactedThinking` (encrypted, no
	// plaintext to keep) and clear `thinking` signatures so the provider encoder
	// downgrades them to plain text (verified accepted by the live API), preserving the
	// visible reasoning while removing the immutability/invalid-signature hazard.
	const keepDanglingToolCallIds = options?.transcript === true ? options.keepDanglingToolCallIds : undefined;
	const pairedToolResultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		let strippedToolCalls = 0;
		for (const block of message.content) {
			if (
				block.type === "toolCall" &&
				!pairedToolResultIds.has(block.id) &&
				!keepDanglingToolCallIds?.has(block.id)
			) {
				strippedToolCalls++;
			}
		}
		if (strippedToolCalls === 0) continue;
		const normalized = message.content
			.filter(
				block =>
					!(
						block.type === "toolCall" &&
						!pairedToolResultIds.has(block.id) &&
						!keepDanglingToolCallIds?.has(block.id)
					) && block.type !== "redactedThinking",
			)
			.map(block =>
				block.type === "thinking" && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block,
			);
		if (normalized.length === 0 && !options?.transcript) {
			messages.splice(i, 1);
		} else {
			const rewritten = { ...message, content: normalized };
			if (options?.transcript) {
				// Display transcript: keep the turn (even content-less) and mark
				// how many calls were dropped so the TUI renders a placeholder
				// row instead of silently erasing the turn's activity.
				(rewritten as AgentMessage & StrippedToolCallsMarker).strippedToolCalls = strippedToolCalls;
			}
			messages[i] = rewritten;
		}
	}

	return {
		messages,
		cacheMissExplainedAt: options?.transcript ? cacheMissExplainedAt : undefined,
		thinkingLevel,
		configuredThinkingLevel,
		serviceTier,
		models,
		injectedTtsrRules,
		selectedMCPToolNames,
		hasPersistedMCPToolSelection,
		mode,
		modeData,
	};
}
