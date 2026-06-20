# Context Maintenance Provider-Call Barrier Execution Plan

## Objective

Make compaction resilient when a long-running agent turn crosses the provider context limit between tool calls.

The specific failure class: an assistant turn succeeds and requests tools while provider usage is already near or over the compaction threshold; tool results are appended; the agent loop immediately sends the next provider request before post-turn maintenance can run. If the provider's true context accounting is higher than OMP's local estimate, Codex/OpenAI rejects the request with `context_length_exceeded`. Remote compaction may then fail or be cancelled, and overlapping recovery paths can append duplicate or stale compactions.

The fix is not primarily a different OpenAI remote-compaction fallback. The high-value fix is a hard provider-call barrier: every model request must be preceded by an inline, authoritative context-maintenance check against the exact provider-bound context. If maintenance compacts, the active loop must re-materialize the provider request from the compacted context. If maintenance cannot make the request safe, the loop must fail closed before calling the provider.

## Review Status

This plan was reviewed with three independent workflow lenses before finalization:

- concurrency/state-machine review;
- API/scope/design review;
- verification/observability review.

The first draft assumed `EventStream.queue.length === 0` was enough to prove event consumption, estimated raw `AgentContext` instead of the transformed provider request, and did not specify a durable visible maintenance-error path. Those issues are addressed below as P0 requirements, not follow-ups.

## Incident Evidence

Session investigated:

- `/Users/case/.omp/agent/sessions/-projects-agent-gateway/2026-06-07T01-56-12-718Z_019e9fcb-792e-7000-b315-9993b7ebfac2.jsonl`

Observed sequence:

1. A successful assistant turn reported approximately `271,599` total provider tokens.
2. The assistant requested a tool.
3. The tool result was appended.
4. The next Codex request failed with `context_length_exceeded` before normal post-turn compaction had completed.
5. OpenAI remote compaction failed with `The operation was aborted`; local fallback eventually succeeded.
6. Two compaction entries were appended close together from the same `tokensBefore` value, implying overlapping/stale recovery work was allowed to commit.

The accidental `/shake` changed forensic payloads after the fact, but did not cause the original overflow path.

## Current Code Map

### Provider-call loop

- `packages/agent/src/agent-loop.ts`
  - `runLoopBody` owns the inner loop.
  - Before every provider call it invokes `config.syncContextBeforeModelCall(currentContext)`.
  - It then calls `streamAssistantResponse(currentContext, ...)`.
  - `streamAssistantResponse` applies `transformContext`, calls `convertToLlm`, normalizes messages/tools, optionally builds append-only context, and only then calls `streamFunction(...)`.
  - After a tool-use assistant turn, `runLoopBody` executes tools, pushes tool results into `currentContext.messages`, and loops back to the next provider call.

Important details:

- `currentContext.messages` is the authoritative in-flight agent-domain context, but it is not necessarily the exact provider request. `transformContext`, `convertToLlm`, provider normalization, tool normalization, and append-only context can change what the provider sees.
- `EventStream.push()` has no consumer backpressure. The producer can push `message_end` / `toolResult` events and continue before `Agent.#runLoop` and `AgentSession.#handleAgentEvent` have finished processing them.
- `EventStream.push()` can deliver directly to a waiting iterator without adding to `queue`; therefore `queue.length === 0` does not prove an event was consumed or persisted.
- `Agent` currently uses `await Bun.sleep(0)` inside its hardcoded `syncContextBeforeModelCall` to give listeners a chance to catch up before refreshing system prompt and tools. That is a scheduling hint, not a correctness barrier.

### Agent state and event consumption

- `packages/agent/src/agent.ts`
  - `Agent.#runLoop` consumes the `EventStream` and mutates `this.#state.messages` on `message_end`.
  - `Agent.#emit` invokes listeners but does not await listener promises.
  - `syncContextBeforeModelCall` currently refreshes only `context.systemPrompt` and `context.tools`.
  - Generic thrown errors in `Agent.#runLoop` append an error assistant to `Agent.state`, but they do not currently emit normal `message_start` / `message_end` events except for special output-blocked handling.

Important details:

- `Agent.state.messages` is current only after the outer `Agent.#runLoop` has consumed queued/delivered events.
- `SessionManager` persistence lives in an async listener, so a single event-loop tick is not a durable guarantee that the session branch includes the latest tool result.
- A provider-call maintenance failure needs an explicit visible/persisted event path; throwing a generic error is not enough today.

### Session persistence and post-turn maintenance

- `packages/coding-agent/src/session/agent-session.ts`
  - `#handleAgentEvent` persists `message_end` entries and tracks `#lastAssistantMessage`.
  - Post-turn maintenance runs on `agent_end` via `#checkCompaction(msg)`.
  - `#checkCompaction` handles overflow, incomplete responses, and threshold compaction.
  - Threshold compaction currently uses the successful assistant's reported usage, then calls `#runAutoCompaction("threshold", ...)`.
  - `#runPrePromptCompactionIfNeeded` protects new user/developer prompt entrypoints, not internal tool-result continuations.

Important details:

- `agent_end` occurs after the entire tool loop stops. It is too late for a continuation request issued after a tool result in the same agent run.
- `#runPrePromptCompactionIfNeeded` estimates a pending user prompt path only. It does not run for the next model call inside `agentLoop` after tools.
- `#runAutoCompaction` can be called from several paths and currently aborts older auto-compaction controllers when a newer run starts.
- Existing history rewrite paths call `#closeCodexProviderSessionsForHistoryRewrite()`. Inline compaction must preserve that reset or Codex/OpenAI session replay can reuse stale provider-side history after messages are replaced.

### Compaction preparation and append

- `packages/agent/src/compaction/compaction.ts`
  - `prepareCompaction(pathEntries, settings)` refuses to prepare if the latest branch entry is already a compaction.
  - It uses `getLastAssistantUsage(pathEntries)` for `tokensBefore`.
  - It computes a cut point from persisted session entries.

- `packages/coding-agent/src/session/session-manager.ts`
  - `appendCompaction(...)` appends a compaction as a child of the current leaf and advances the leaf.
  - It returns the new entry id, but current session code often refinds the saved compaction by matching summary text.

Important details:

- A compaction result is only valid for the branch leaf and branch contents used to prepare it.
- If another event, tool result, handoff, branch move, or compaction changes the leaf while the summary LLM call is running, blindly appending the old result can create duplicate/stale compaction entries.

### Remote OpenAI compaction

- `packages/agent/src/compaction/openai.ts`
  - `requestOpenAiRemoteCompaction` sends the native OpenAI compact request using the caller's abort signal.
  - It logs non-OK HTTP responses but does not classify abort reasons.

- `packages/agent/src/compaction/compaction.ts`
  - `compact` catches all remote compaction errors, logs `OpenAI remote compaction failed, falling back to local summarization`, and proceeds to local summarization using the same caller signal.

Important details:

- `The operation was aborted` is ambiguous today: it could be a user/session cancellation, a timeout-like fetch abort, a transport closure, or a cascading abort from a newer auto-compaction run.
- Remote compaction failure was not fatal in the incident because local summarization succeeded. The missing provider-call barrier was the root reliability issue.

## Completed-State Claims

After this plan is complete:

1. No provider request is sent while OMP already knows the provider-bound context is above the hard context window.
2. No provider request is sent while OMP knows the provider-bound context is above the configured compaction threshold and inline maintenance can still run.
3. Tool-result continuations are protected by the same maintenance policy as new prompts.
4. The context sent after inline maintenance is re-materialized from the compacted context, not the stale pre-compaction `currentContext.messages` array.
5. A compaction result cannot append to a branch different from the one it summarized.
6. Concurrent auto-compaction attempts cannot produce duplicate compaction entries for the same branch window.
7. OpenAI remote-compaction abort logs distinguish user/session aborts from remote/timeout failures that should fall back locally.
8. If required maintenance fails, the agent fails closed with a visible persisted maintenance error instead of knowingly issuing an oversized provider request.
9. Codex/OpenAI provider session replay state is reset after inline history rewrites.

## Design Principles

### The provider-call boundary is the hard safety boundary

Post-turn maintenance is useful for idle cleanup, but it is not sufficient for correctness. The only place that can guarantee safety is immediately before `streamFunction(...)`, after all pending tool results and steering messages for that next request are present and after provider-bound context has been materialized.

### Agent-domain context and provider-bound context are different objects

`currentContext.messages`, `context.systemPrompt`, and `context.tools` are necessary but not sufficient. The provider call is built after `transformContext`, `convertToLlm`, provider-specific normalization, tool normalization, and append-only-context construction. The barrier must estimate the materialized provider `Context`, or it can pass a raw context that later overflows after extension/provider transforms.

### Persisted branch is authoritative for compaction commits

A compaction entry is a durable rewrite boundary. It must be prepared from and appended to the same branch state. If the branch changes while summarization is running, discard or reprepare; never attach the stale result as a child of the new leaf.

### Handoff is not safe inside a live tool loop

`handoff()` resets session and agent state. It is reasonable before a prompt starts or after an agent run ends; it is not safe as the inline maintenance action inside the active `agentLoop` producer. The provider-call barrier should force context-full compaction or fail closed. Existing handoff behavior can remain for pre-prompt and post-turn maintenance.

### Remote compaction is an optimization, not the recovery invariant

Native OpenAI compaction can preserve provider-side encrypted history, but local summarization is the correctness fallback. Abort classification should be precise, but the core invariant is that a failed remote compact cannot allow the next oversized request to proceed.

## Implementation Plan

### P0: Add a two-stage provider-call barrier

**Seams**

- `packages/agent/src/types.ts`
  - `AgentLoopConfig.syncContextBeforeModelCall`
  - new provider-context preflight hook type
- `packages/agent/src/agent-loop.ts`
  - `runLoopBody`
  - `streamAssistantResponse`
- `packages/agent/src/agent.ts`
  - `AgentOptions`
  - `Agent.#runLoop` config construction
- `packages/coding-agent/src/sdk.ts`
  - session/agent construction wiring
- `packages/coding-agent/src/session/agent-session.ts`
  - new session-owned provider-call maintenance/preflight methods

**Problem**

`AgentLoopConfig.syncContextBeforeModelCall` already exists, but `Agent` hardcodes it to a lightweight system/tool refresh. More importantly, that hook runs before `streamAssistantResponse` materializes the provider request. A large `transformContext` extension or provider normalization can still push the final request over the limit after the hook passes.

**Change**

Add a two-stage barrier:

1. **Agent-domain sync stage** before provider materialization.

   - Drain already-dispatched events through a real acknowledgement barrier.
   - Refresh system prompt/tools from live `Agent.state`.
   - Allow coding-agent to run cheap or durable maintenance that depends on current agent/session state.
   - If maintenance compacts, mutate `currentContext.messages` and later re-materialize provider context.

2. **Provider-bound preflight stage** after materialization and before `streamFunction(...)`.

   - Materialize the provider `Context` by applying `transformContext`, `convertToLlm`, `normalizeMessagesForProvider`, `normalizeTools`, and append-only-context build.
   - Estimate this materialized provider `Context`.
   - If unsafe, call session maintenance and request a re-materialization.
   - Re-run materialization and preflight after compaction.
   - Cap retries, for example two materialization/maintenance cycles, then fail closed.

A concrete shape:

```ts
interface ProviderContextPreflightInput {
  readonly agentContext: AgentContext;
  readonly providerContext: Context;
  readonly signal?: AbortSignal;
}

type ProviderContextPreflightResult =
  | { action: "continue" }
  | { action: "rematerialize" }
  | { action: "abort"; error: Error };
```

`streamAssistantResponse` should not call `streamFunction` until provider preflight returns `continue` and `signal` is still live.

**Agent option wiring**

Extend `AgentOptions` with optional hooks, for example:

```ts
syncContextBeforeModelCall?: (context: AgentContext, signal?: AbortSignal) => Promise<void> | void;
preflightProviderContext?: (input: ProviderContextPreflightInput) => Promise<ProviderContextPreflightResult> | ProviderContextPreflightResult;
```

Store these in `Agent` and thread them into `AgentLoopConfig`.

In `sdk.ts`, pass closures that reference the session after construction:

```ts
let session: AgentSession | undefined;
const syncContextBeforeModelCall = async (context: AgentContext, signal?: AbortSignal) => {
  await session?.syncContextBeforeModelCall(context, signal);
};
const preflightProviderContext = async (input: ProviderContextPreflightInput) => {
  return (await session?.preflightProviderContext(input)) ?? { action: "continue" };
};
```

Then assign `session = new AgentSession(...)` as today. This avoids reconstructing the `Agent` after `AgentSession` exists.

**Abort rule**

After each sync/preflight hook, `runLoopBody` / `streamAssistantResponse` must check `signal?.aborted`. If aborted, emit/return an aborted assistant without invoking `streamFunction`. Do not rely on provider fetch to notice an already-aborted signal; the current code calls `streamFunction` before the internal abort race check.

**Acceptance criteria**

- The coding-agent session can run logic at every provider-call boundary, including internal tool-result continuations.
- The final safety estimate is based on the materialized provider `Context` that would be sent to `streamFunction`.
- If compaction happens in either stage, the provider context is re-materialized before sending.
- If abort happens during either stage, no provider stream function is called.
- Existing direct `Agent` users that do not provide hooks preserve current behavior.

**Tests**

- Add an `Agent` unit test where a fake stream function emits a tool call, the tool result is appended, and the custom sync hook mutates `context.messages` before the second stream call. Assert the second stream call receives the mutated messages.
- Add a provider-preflight test where `transformContext` adds a large message after raw sync passes. Assert provider preflight catches it and prevents the stream call until compaction/rematerialization.
- Add a cancellation test that aborts during sync/preflight and asserts no provider stream call is made after abort.

### P0: Replace the `Bun.sleep(0)` listener catch-up hint with explicit event acknowledgements

**Seams**

- `packages/agent/src/agent.ts`
  - `Agent.#emit`
  - `Agent.#runLoop`
- `packages/ai/src/utils/event-stream.ts`
  - add internal pushed-event sequencing if needed

**Problem**

The current sync hook waits one tick when listeners exist. The first draft proposed polling `activeStream.queue.length`, but that is still incorrect: `EventStream.push()` can resolve a waiting iterator directly without adding to `queue`. Queue emptiness says nothing about whether `Agent.#runLoop` ran its event switch, mutated `Agent.state`, called `#emit`, or whether session persistence settled.

**Change**

Add an explicit pushed/processed acknowledgement barrier.

One workable design:

1. Add an internal pushed-event counter to `EventStream`:

   - increment on every `push` / `deliver`;
   - expose `pushedCount` as a read-only number.

2. In `Agent.#runLoop`, track processed events for the active stream:

   - after the `switch (event.type)` mutates `Agent.state`;
   - after `#emit(event)` has registered any listener promises for that event;
   - record the event as processed.

3. Track async listener tasks by event ordinal:

   - when `#emit` sees a listener promise, associate it with the currently processed event ordinal;
   - the provider-call drain waits only listener tasks for events at or below the target ordinal, not unrelated future events.

4. At the start of the provider-call sync stage:

   - capture `target = activeStream.pushedCount`;
   - wait until `processedCount >= target`;
   - wait until listener tasks for ordinals `<= target` settle;
   - repeat if needed until no already-pushed event remains unprocessed.

5. Do not depend on `queue.length` for correctness. It can be used only as a diagnostic.

6. Keep the scope narrow:

   - drain only before model calls;
   - do not make every `EventStream.push()` awaitable;
   - do not serialize all streaming token updates;
   - do not block on listener promises for events pushed after the captured target.

If adding sequencing to generic `EventStream` is too broad, implement the same counters in the Agent stream wrapper used by `createAgentStream()`. The invariant matters more than the exact location: the provider-call barrier must know that all events pushed before the barrier have been consumed and their durable listeners have settled.

**Acceptance criteria**

- Before the provider-call hook inspects session state, all `message_end` events already pushed by the loop have been consumed by `Agent.#runLoop` and all async listeners from those events have settled.
- The old single-tick sleep is gone or only remains as a polling yield inside an explicit target/ack loop.
- The barrier handles both queued events and directly delivered events.
- Streaming token updates are not forced through a global sequential queue.

**Tests**

- Add a fake async listener that delays `message_end` handling. Assert the provider-call hook does not run until the listener promise settles.
- Add a regression test where the async iterator is already waiting when a tool-result `message_end` is pushed. Assert the provider-call hook still waits for consumption and persistence.
- Add a regression test where a slow listener for a later event does not block a barrier whose target was captured before that later event.

### P0: Add session-owned inline context maintenance

**Seams**

- `packages/coding-agent/src/session/agent-session.ts`
  - new `syncContextBeforeModelCall(context, signal)` method
  - new `preflightProviderContext(input)` method
  - `#runPrePromptCompactionIfNeeded`
  - `#runAutoCompaction`
  - token-estimation helpers around `#estimatePendingPromptTokens`

**Problem**

The current threshold check can run only after `agent_end` or before a fresh prompt. It cannot protect the next model call inside an active run after tool results are appended. It also does not inspect provider-bound context after transforms.

**Change**

Add two session methods called by the new agent hooks:

```ts
async syncContextBeforeModelCall(context: AgentContext, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ContextMaintenanceAbortedError();
  await this.#maybeRunRawContextMaintenance(context, signal);
}

async preflightProviderContext(input: ProviderContextPreflightInput): Promise<ProviderContextPreflightResult> {
  if (input.signal?.aborted) return { action: "abort", error: new ContextMaintenanceAbortedError() };
  const decision = this.#decideProviderContextMaintenance(input.providerContext);
  if (decision.action === "continue") return { action: "continue" };
  await this.#runProviderCallContextMaintenance(decision, input.agentContext, input.signal);
  return { action: "rematerialize" };
}
```

The decision helper should:

1. Read the active model and compaction settings.
2. Estimate the materialized provider context using the helper described below.
3. Separate policy threshold from hard safety:
   - if `effectiveEstimate >= contextWindow`, fail closed or compact even if compaction is disabled/off;
   - if below hard context window but above threshold, compact only when compaction is enabled and strategy is not off;
   - if compaction is disabled/off and the request is below the hard context window, allow the user's configuration to proceed.
4. Return a discriminated decision: `continue`, `compact`, or `failClosed`.

The maintenance helper should:

1. Emit/log `source: "before_model_call"`.
2. Force context-full compaction for this inline path, even when user configuration prefers handoff.
3. Use an inline-specific compaction API, not the current boolean-only `#runAutoCompaction` contract, unless `#runAutoCompaction` is first extended with:
   - `source: "before_model_call"`;
   - `forceAction: "context-full"`;
   - `scheduling: "none"`;
   - `sourceSignal` composed with the compaction controller;
   - a discriminated result: `appended`, `skipped`, `stale`, `already_compacted`, `failed`, `cancelled`.
4. Disable all auto-continue scheduling for inline maintenance.
5. Avoid goal post-compaction continuation dispatch that would start another turn. It is fine to arm state for the next normal continuation, but the current provider-call barrier must not enqueue a separate `agent.continue()` or synthetic prompt.
6. After a successful append/rewrite:

   ```ts
   const sessionContext = this.buildDisplaySessionContext();
   this.agent.replaceMessages(sessionContext.messages);
   this.#closeCodexProviderSessionsForHistoryRewrite();
   input.agentContext.messages = sessionContext.messages.slice();
   input.agentContext.systemPrompt = this.agent.state.systemPrompt;
   input.agentContext.tools = this.agent.state.tools;
   ```

7. Return `rematerialize` so `streamAssistantResponse` rebuilds the provider-bound context from the compacted agent context and re-runs preflight.

**Why force context-full here**

`handoff()` resets the session and agent state. Running it inside an active `agentLoop` would leave `newMessages`, in-flight event state, and the loop's current turn accounting tied to the pre-handoff session. That is a larger state-machine change. The inline barrier should use context-full compaction as the safe local rewrite. Existing pre-prompt and post-turn paths can still use handoff.

**Acceptance criteria**

- A tool-result continuation that crosses threshold compacts before the next provider request.
- The provider call after inline compaction receives re-materialized compacted messages.
- Inline compaction does not schedule an extra `agent.continue()` or auto-continue prompt.
- Inline compaction never runs handoff inside the active loop.
- Inline compaction resets Codex/OpenAI provider session replay state after rewriting history.
- If inline maintenance fails while the provider-bound context is unsafe, no provider request is sent.

**Tests**

- Integration-style test with a fake model/stream:
  1. First assistant response has `usage.totalTokens` above threshold and includes one tool call.
  2. Tool returns a result.
  3. Provider-call preflight runs compaction.
  4. Second fake provider call asserts its input starts with a compaction summary and excludes summarized old messages.
  5. Session file has exactly one compaction entry.
- Failure test where compaction summarization throws. Assert the second provider call is not invoked and the surfaced/persisted error mentions context maintenance failure.
- Codex/OpenAI regression test that asserts provider session/replay state is reset before the next request after inline compaction.

### P0: Estimate the materialized provider context and use provider usage as a bounded floor

**Seams**

- `packages/agent/src/compaction/compaction.ts`
  - `calculateContextTokens`
  - `calculatePromptTokens`
  - `estimateTokens`
- `packages/coding-agent/src/modes/utils/context-usage.ts`
  - `computeNonMessageTokens`
  - `estimateToolSchemaTokens`
- `packages/coding-agent/src/session/agent-session.ts`
  - `#estimatePendingPromptTokens`
  - new provider-context estimate helper

**Problem**

Local token estimates can undercount provider-native context for Codex/OpenAI Responses, especially when encrypted history, cached input, native tool metadata, or provider-specific wrappers are involved. Raw `AgentContext` estimates can also undercount extension-injected context. The last successful assistant usage is the best observed lower bound for the provider's own accounting, but it is valid only within strict boundaries.

**Change**

Add a helper that estimates the materialized provider context, not just `AgentContext`:

```ts
#estimateProviderContextTokens(input: {
  providerContext: Context;
  agentContext: AgentContext;
  model: Model;
}): {
  localEstimate: number;
  usageFloor: number;
  effectiveEstimate: number;
}
```

Suggested algorithm:

1. `localEstimate`:
   - count `providerContext.systemPrompt`;
   - count normalized `providerContext.tools` with `estimateToolSchemaTokens` or a provider-context equivalent;
   - sum estimated tokens for provider `Message[]` after conversion, including text, thinking, tool calls, tool results, and image estimates.

2. `usageFloor`:
   - find the latest compaction boundary in the corresponding agent/session context;
   - find the last assistant message after that boundary with non-error, non-aborted usage;
   - require `assistant.provider === activeModel.provider` and `assistant.model === activeModel.id`;
   - compute `base = calculateContextTokens(assistant.usage)`;
   - add estimated tokens for messages after that assistant index, usually tool results and steering messages;
   - ignore usage from older models, pre-compaction kept regions, error messages, and aborted messages.

3. `effectiveEstimate = Math.max(localEstimate, usageFloor)`.

4. Use `effectiveEstimate` for both:
   - provider-call preflight;
   - pre-prompt compaction checks by constructing/materializing a temporary context with pending prompt messages.

5. Keep `/context` UI local-estimate semantics unless a separate UI change is desired.

**Acceptance criteria**

- If provider usage says the current same-model post-compaction conversation is already above threshold, the next provider-call guard triggers even when local estimate is lower.
- Tool results after the last valid assistant usage are included in the floor.
- Usage from a previous model or before the latest compaction cannot keep the floor artificially high after successful compaction.
- Pre-prompt and provider-call checks use the same estimator.

**Tests**

- Unit test where local estimate is below threshold but last same-model assistant `usage.totalTokens` is above threshold. Assert maintenance triggers.
- Unit test where last assistant usage is below threshold but a large tool result after it pushes the usage floor above threshold. Assert maintenance triggers.
- Unit test with an error/aborted assistant usage. Assert it is ignored for the usage floor.
- Unit test with a model switch. Assert usage from the old model is ignored.
- Unit test with a compaction summary followed by kept old assistant usage. Assert pre-compaction usage is ignored.

### P0: Add a visible and durable maintenance-error path

**Seams**

- `packages/agent/src/agent-loop.ts`
  - sync/preflight hook error handling
- `packages/agent/src/agent.ts`
  - generic error handling in `#runLoop`
- `packages/coding-agent/src/session/agent-session.ts`
  - persistence of maintenance errors

**Problem**

The desired failure mode is "no provider call, visible error, durable transcript". Throwing a generic error from the provider-call hook is not enough today: generic errors are appended to `Agent.state` and emitted in `agent_end`, but no normal `message_end` is emitted for session persistence.

**Change**

Add an explicit maintenance error contract. Two acceptable implementations:

1. Add a typed `ContextMaintenanceError` that `Agent.#runLoop` handles by emitting:
   - `message_start` for an assistant error;
   - `message_end` for the same assistant error;
   - `turn_end`;
   - `agent_end`.

2. Or add a new `AgentEvent` / session event for provider-call maintenance failure and have `AgentSession` persist a corresponding assistant error entry.

Recommendation: use the first option because it preserves the existing transcript model of provider failures as assistant messages.

**Acceptance criteria**

- If required inline maintenance fails, no provider stream function is called.
- The user sees a concrete error message.
- The session file contains a durable assistant error entry.
- The error path does not look like a provider response; it should identify context maintenance as the source.

**Tests**

- Hook throws `ContextMaintenanceError`; assert `message_start`, `message_end`, `turn_end`, and `agent_end` are emitted.
- Session integration test asserts the error is persisted.
- Assert generic non-maintenance errors keep existing behavior unless intentionally changed.

### P0: Make compaction commits branch-stale safe

**Seams**

- `packages/coding-agent/src/session/agent-session.ts`
  - manual `compact`
  - `#runAutoCompaction`
  - new inline compaction path
- `packages/coding-agent/src/session/session-manager.ts`
  - `getLeafId`
  - `appendCompaction`
- `packages/agent/src/compaction/compaction.ts`
  - `prepareCompaction`

**Problem**

`prepareCompaction()` returns a summary plan for the branch snapshot passed in. `#runAutoCompaction` can then spend time in extension hooks, remote compaction, and local summarization. During that time, the session leaf can change. Today `appendCompaction()` always appends to the current leaf, even if that leaf is no longer the one used to prepare the summary.

**Change**

1. Capture a commit token immediately before preparation:

   ```ts
   const baseLeafId = this.sessionManager.getLeafId();
   const pathEntries = this.sessionManager.getBranch();
   const baseLatestCompactionId = getLatestCompactionEntry(pathEntries)?.id;
   const preparation = prepareCompaction(pathEntries, compactionSettings);
   ```

2. Add a helper, for example:

   ```ts
   #tryAppendPreparedCompaction(input: {
     baseLeafId: string | null;
     baseLatestCompactionId?: string;
     result: CompactionResult;
     fromExtension: boolean;
   }): { status: "appended"; entryId: string } | { status: "stale" | "already_compacted" };
   ```

3. Before append:

   - If `sessionManager.getLeafId() === baseLeafId`, append.
   - Else if the current branch's latest compaction id differs from `baseLatestCompactionId`, treat another compaction as already winning. Discard this result and rebuild agent messages from current session context.
   - Else the branch changed for a non-compaction reason. Discard and, for inline provider-call maintenance only, re-run preparation once from the fresh branch if still over threshold. Do not append the stale result.

4. Use the `entryId` returned by `appendCompaction()` for follow-up hook emission. Stop refinding the saved entry by `summary` text.

5. Apply the helper to manual, auto, and inline compaction paths. Manual compaction already aborts active agent work first, so stale status should be rare; surfacing a clear error is better than appending wrong history.

**Acceptance criteria**

- Two overlapping auto-compactions cannot append two summaries for the same branch window.
- A delayed remote/local summary cannot attach to a branch that acquired new messages after preparation.
- Extension `session_compact` receives the exact saved entry by id.

**Tests**

- Unit/integration test with two concurrent auto-compaction calls prepared from the same leaf. Resolve the second first, then the first. Assert only one compaction entry is appended.
- Test branch mutation between preparation and append. Assert stale append is discarded and the stale summary is not persisted.
- Test duplicate summary text. Assert extension hook receives the entry id returned from `appendCompaction`, not the first matching summary.

### P0: Single-flight auto-compaction scheduling

**Seams**

- `packages/coding-agent/src/session/agent-session.ts`
  - `#autoCompactionAbortController`
  - `#runAutoCompaction`
  - `#runAutoShake`
  - `#scheduleAgentContinue`

**Problem**

`#runAutoCompaction` aborts any older auto-compaction before installing the new controller. That is reasonable for explicit cancellation but poor as the default for multiple threshold/idle callers. It can turn a valid in-progress recovery into an abort-shaped remote failure and lets multiple callers race to append or schedule continuations.

**Change**

1. Track an active auto-compaction promise and metadata:

   ```ts
   #autoCompactionRun?: {
     reason: "overflow" | "threshold" | "idle" | "incomplete";
     source: "post_turn" | "pre_prompt" | "before_model_call" | "idle";
     branchToken: { leafId: string | null; latestCompactionId?: string };
     promise: Promise<CompactionRunResult>;
     controller: AbortController;
   };
   ```

2. Define reason priority:

   - `overflow` and `incomplete` are recovery and may supersede lower-priority threshold/idle work.
   - `before_model_call` threshold should await an equal threshold run if it targets the same branch, or force a stale-safe fresh run if the active run is stale.
   - `idle` should skip when any active compaction exists.

3. Do not abort an active compaction merely because another threshold check fires.

4. Ensure only the run that actually appended schedules auto-continue. Inline provider-call maintenance uses `scheduling: "none"`.

**Acceptance criteria**

- Duplicate threshold checks coalesce instead of racing.
- Idle compaction never aborts overflow or before-model-call recovery.
- Logs show when a run awaited, skipped, superseded, or appended.

**Tests**

- Concurrent threshold callers share or coalesce to one append.
- Idle call during active overflow returns skipped without aborting overflow.
- Overflow during active idle aborts/supersedes idle and runs recovery.

### P1: Classify OpenAI remote-compaction aborts and timeouts

**Seams**

- `packages/agent/src/compaction/openai.ts`
  - `requestOpenAiRemoteCompaction`
  - generic `requestRemoteCompaction` if the setting is meant to apply to extension endpoints too
- `packages/agent/src/compaction/compaction.ts`
  - `CompactionSettings`
  - remote fallback catch block in `compact`
- `packages/coding-agent/src/config/settings-schema.ts`
  - mirrored settings/defaults

**Problem**

Remote compaction logs currently collapse aborts into a generic fallback warning. In the incident, `The operation was aborted` did not tell us whether a user cancellation, auto-compaction supersession, remote timeout, or fetch-level transport issue occurred.

**Change**

1. Add an optional remote timeout, for example `compaction.remoteTimeoutMs`, with a conservative default such as 20-30 seconds. Thread it through both settings schema/defaults and core `CompactionSettings`.
2. In `requestOpenAiRemoteCompaction`, compose signals:

   - caller/session signal;
   - timeout signal.

3. On error, classify:

   - caller signal aborted: throw/preserve `CompactionCancelledError` or a typed cancellation so higher-level code stops;
   - timeout signal aborted but caller signal not aborted: throw/return a remote-timeout error that `compact` treats as local-fallback eligible;
   - non-OK HTTP: log status and fallback;
   - malformed response: log output types and fallback.

4. Log structured fields:

   - endpoint;
   - model/provider;
   - `callerSignalAborted`;
   - `timeoutMs`;
   - `timedOut`;
   - error name/message;
   - status/statusText when available.

5. In `compact`, do not local-fallback when the caller/session signal is aborted. Fallback only for remote failure while the caller signal is still live.

6. Decide whether the timeout applies to generic `requestRemoteCompaction` endpoints. Recommendation: apply it there too unless an extension API explicitly needs a different timeout contract.

**Acceptance criteria**

- User/session cancellation stops compaction without starting local summarization.
- Remote timeout or remote endpoint failure falls back to local summarization.
- Logs can distinguish timeout/fallback from user cancellation.

**Tests**

- Fake fetch rejects with `AbortError` while caller signal is aborted. Assert local summarization is not called.
- Fake fetch rejects with timeout abort while caller signal is not aborted. Assert local summarization is called.
- Fake fetch returns 500. Assert fallback and structured warning.

## Failure Semantics

### If inline maintenance succeeds

- Rebuild session context.
- Replace agent state messages.
- Reset Codex/OpenAI provider session replay state via the existing history-rewrite close path.
- Mutate `currentContext.messages` to the rebuilt messages.
- Re-materialize provider context.
- Continue the same agent loop to the provider call only after provider preflight passes.

### If inline maintenance determines no compaction is needed

- Continue only if provider-bound preflight says the final materialized context is below the hard context window and below any enabled threshold.
- Leave refreshed system prompt/tools in place.

### If compaction is disabled/off

- If the provider-bound context is below the hard context window, honor the user's setting and proceed.
- If the provider-bound context is at/above the hard context window, fail closed with a configuration/context error before calling the provider.

### If inline maintenance is needed but fails

- Do not call the provider with known-unsafe context.
- Emit and persist a context-maintenance assistant error via the explicit error path above.
- Keep the transcript branch intact so the user can retry, manually compact, switch models, or lower context.

### If the user aborts during inline maintenance

- Treat as cancellation, not remote failure.
- Do not call the provider after the hook returns.
- Do not schedule auto-continue.
- Do not append partial compaction.

## Compatibility Notes

- Existing `transformContext` remains provider-message shaping. Do not overload it with durable compaction side effects.
- Existing `#runPrePromptCompactionIfNeeded` remains valuable because it can run before the agent loop starts and can safely use handoff. It should share the new estimator.
- Existing post-`agent_end` `#checkCompaction` remains valuable for idle cleanup, overflow recovery after provider errors, empty-stop handling, todo reminders, and handoff strategy.
- The new provider-call barrier should be additive and narrowly scoped to the exact context about to be sent.

## Rollout Order

1. Add tests around the current race using fake stream/tool calls. Mark the expected current behavior as failing locally before changing logic.
2. Add the explicit event acknowledgement barrier. Do not use queue length as correctness proof.
3. Add Agent-level raw sync and provider-bound preflight hooks with abort checks before `streamFunction`.
4. Add the explicit visible/persisted maintenance-error path.
5. Add session-owned provider-call maintenance using a dedicated inline context-full result contract.
6. Add materialized provider-context estimation and provider-usage floor; route pre-prompt checks through it.
7. Add stale-safe compaction commit helper and use returned compaction ids.
8. Add single-flight auto-compaction metadata to remove duplicate append races.
9. Add remote-compaction abort/timeout classification.
10. Re-run the reproduction test and package-local checks.

## Verification Plan

Run focused package-local verification only:

- `bun test packages/agent/...` for Agent loop hook/event-ack/preflight/error-path tests.
- `bun test packages/coding-agent/...` for session compaction race, provider-session reset, and stale-commit tests.
- `bun check` only after implementation touches public TypeScript types or cross-package imports.

Do not add broad snapshots that assert incidental prompt text. The core contracts are:

- no provider call before required maintenance;
- final provider-bound context is estimated, not just raw agent context;
- compacted messages are re-materialized and sent after maintenance;
- stale compactions do not commit;
- maintenance errors are visible and persisted;
- cancellation and remote fallback are classified correctly;
- provider replay state is reset after inline history rewrites.

## Open Questions

1. Whether `compaction.remoteTimeoutMs` should be user-configurable immediately or hardcoded first. Recommendation: add config because remote compaction is provider/network dependent.
2. Whether inline before-model-call maintenance should have a distinct session event reason. Recommendation: add a source/detail field if event type evolution is cheap; otherwise start with structured logs and add event typing with UI follow-up.
3. Whether event acknowledgements should live in generic `EventStream` or an Agent-specific stream wrapper. Recommendation: use the narrowest Agent-specific implementation that can prove pushed-before-barrier events were processed and durable listeners settled.
4. Whether generic listener promises or only session-persistence promises should block the provider-call barrier. Recommendation: start with event-ordinal-scoped listener promises for correctness, then split durable persistence acknowledgement from non-critical subscribers if latency appears.
