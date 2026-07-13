# Context Span Checkpoints

Status: implementation target

## Summary

A checkpoint marks the start of a bounded context span. It does not imply that the span is speculative, disposable, successful, or complete. An open checkpoint closes through exactly one disposition:

| Disposition | Meaning | Active-context result |
| --- | --- | --- |
| `rewind` | Abandon the trajectory but retain what was learned | Branch from checkpoint; replace span with report |
| `seal` | Accept the trajectory as durable work and compact it | Preserve close-time durable state; compact span |
| `keep` | Retain the trajectory in full | Close marker; no compaction |

`seal` supports two strategies:

| Strategy | Behavior |
| --- | --- |
| `summary` | Replace eligible span content with an assistant-authored report plus a runtime-generated execution manifest |
| `shake` | Preserve chronology but artifact-elide eligible heavy payloads within the span |

The original detailed trajectory remains recoverable. Todo completion may suggest sealing but never triggers it automatically.

## Problem

Current `checkpoint`/`rewind` is optimized for exploratory branches. A successful checkpoint tool result becomes the branch anchor. Rewind later moves the active leaf to that anchor, appends a branch summary and retained report, rebuilds provider context, resets advisors, and synchronizes todo state from the retained branch.

That is coherent for rejected exploration. It is asymmetric for productive work:

- filesystem and external side effects survive;
- active context returns to the checkpoint;
- todo state rewinds to the retained branch;
- detailed work remains in the session tree but leaves active context.

A completed phase needs different semantics: accept its world changes, preserve close-time orchestration state, and replace chronology with a durable continuation handoff.

Target principle:

> A bounded trajectory may be compacted when its durable state can replace its detailed chronology without reducing continuation correctness.

## Goals

The implementation MUST:

1. Compact a verified completed phase into a continuation handoff.
2. Preserve close-time todo state when successful work is sealed.
3. Preserve detailed evidence outside active context.
4. Keep speculative rewind behavior backward compatible.
5. Provide a no-compaction escape hatch.
6. Support deterministic scoped Shake.
7. Support semantic sealing with provenance stronger than an assistant summary alone.
8. Keep todo integration explicit.
9. Preserve authoritative instructions verbatim.
10. Make state behavior predictable across all dispositions.
11. Prevent open checkpoints from forcing unsafe compaction.
12. Distinguish observed execution from assistant interpretation.

## Non-goals

The implementation MUST NOT:

1. Roll back filesystem, process, browser, IRC, or network effects.
2. Treat todo completion as proof that compaction is safe.
3. automatically seal todo phases.
4. delete the original session trajectory.
5. summarize user, developer, or system instructions into assistant prose.
6. represent a seal report as a user instruction.
7. support nested checkpoints initially.
8. automatically select a seal strategy initially.
9. infer semantic correctness from a command exit code.
10. preserve ephemeral edit anchors as durable phase state.
11. create a second todo/phase state machine.
12. recursively summarize previous seal reports during ordinary phase sealing.
13. claim that process-memory jobs or pending actions survive a history rewrite.

## State model

| Layer | Examples | Rewind | Summary seal | Shake seal | Keep |
| --- | --- | --- | --- | --- | --- |
| World | Files, processes, browser, network, IRC | Survives | Survives | Survives | Survives |
| Durable orchestration | Todos, persisted goal state, MCP selection | Checkpoint state | Close state when goal mode is inactive; otherwise refused | Close state | Close state |
| Runtime orchestration | Jobs, execution controllers, queues | Must be quiescent | Must be quiescent | Remains live | Remains live |
| Evidence | Exact messages, calls, results | Retained sibling branch | Retained sibling branch | Artifact-backed in branch | Retained |
| Active context | Current model-visible messages | Report replaces span | Report + manifest replace span | Payloads elided | Unchanged |

Context operations MUST NEVER imply that external effects rolled back merely because their messages left active context.

## Tool surface

Keep separate model-facing verbs. Separate tools reduce invalid parameter combinations and make trajectory semantics explicit.

### `checkpoint`

Purpose: mark the beginning of a coherent span that may later be rewound, sealed, or retained.

```ts
interface CheckpointArgs {
  goal: string;
}
```

Rules:

- Exactly one checkpoint may be open.
- Checkpoints remain top-level-only.
- The tool stays discoverable behind `checkpoint.enabled`.
- The current `goal` field remains backward compatible.
- The model MUST close the checkpoint before an ordinary terminal yield.
- Unexpected interruption may leave it open; resume must surface the pending state.

### `rewind`

Purpose: abandon the post-checkpoint trajectory while retaining a factual report.

```ts
interface RewindArgs {
  report: string;
  acknowledgeSurvivingEffects?: boolean;
}
```

Semantics:

- Branch from the successful checkpoint tool-result entry.
- Append the existing `branch_summary`.
- Append a retained rewind report with assistant provenance.
- Restore durable state from the retained branch.
- Keep the detailed trajectory as sibling descendants.
- Rebuild model context and reset context-sensitive provider/advisor sessions.
- Preserve legacy `rewind({ report })` behavior and persisted `rewind-report` compatibility.

Known or opaque durable mutations SHOULD require explicit acknowledgement once an effect journal is available. Rewind never claims rollback.

### `seal`

Purpose: accept the span’s resulting state and compact its active representation.

```ts
interface SealArgs {
  strategy: "summary" | "shake";
  report?: SealReport;
}

interface SealReport {
  outcome: string;
  durableContext: string[];
  decisions: Array<{ decision: string; reason: string }>;
  verification: Array<{ contract: string; evidence: string }>;
  remaining: string[];
  next: string;
}
```

Rules:

- `summary` requires a nonempty structured report.
- `shake` may omit the semantic report.
- `summary` preserves close-time serializable orchestration state.
- `shake` keeps the active branch and applies artifact-backed elision strictly after the checkpoint entry.
- The tool returns a stable evidence reference and compression facts.

### `keep_checkpoint`

Purpose: close the checkpoint without changing its detailed trajectory.

```ts
interface KeepCheckpointArgs {
  reason: string;
}
```

Semantics:

- Keep the active branch and messages.
- Preserve close-time state.
- Append a durable completion marker so resume does not resurrect the checkpoint.
- Do not rebuild provider context.
- Permit another checkpoint immediately.

`keep_checkpoint` is the safety exit and SHOULD remain available whenever a checkpoint exists.

## Lifecycle

```text
closed --checkpoint--> open
open --rewind-------> closed
open --seal(summary)-> closed
open --seal(shake)---> closed
open --keep----------> closed
```

A failed close operation leaves the checkpoint open and active context unchanged.

## Persistence model

The session journal is an append-only entry tree. Active state derives only from the current root-to-leaf branch. New dispositions MUST produce durable completion markers; clearing only in-memory state would resurrect the checkpoint on resume.

### Rewind

Retain the existing sequence:

1. Move leaf to checkpoint result entry.
2. Append `branch_summary`.
3. Append contextual `custom_message` with `customType: "rewind-report"`.
4. Rebuild active model context.
5. Restore MCP selection.
6. reset advisors.
7. synchronize todo state from retained branch.
8. close replay-sensitive provider sessions.

### Keep

Append a branch-local custom completion marker without moving the leaf:

```ts
{
  customType: "checkpoint-keep";
  details: {
    goal: string;
    reason: string;
    startedAt: string;
    completedAt: string;
  };
}
```

Rehydration recognizes it as completion of the newest preceding checkpoint.

### Summary seal

Before moving the leaf, capture close-time serializable state and the detailed-span evidence reference. Then:

1. Validate quiescence, protected entries, and report content.
2. Refuse summary sealing while goal mode is active; Shake seal and keep remain safe alternatives.
3. Persist raw-span evidence.
4. Generate the execution manifest.
5. In one entry-journal transaction:
   - move the leaf to the checkpoint entry;
   - append `branch_summary`;
   - append the close-time `user_todo_edit` snapshot;
   - append the assistant-provenance `checkpoint-seal-report`;
   - append the runtime-generated manifest digest;
   - append the final hidden `checkpoint-seal` completion marker.
6. Rebuild context, MCP selections, todo projection, advisors, and provider sessions through the history-rewrite path used by rewind.

Only the final completion marker closes the checkpoint during replay. A partial report or manifest is never treated as completed. The detailed descendants remain in the session tree; summary sealing rewrites active history but does not delete evidence.

### Shake seal

Do not move the leaf. Resolve the active checkpoint’s successful tool-result entry and select entries strictly after it:

1. Resolve the boundary; fail closed if missing.
2. Collect eligible regions only from the strict suffix.
3. Persist originals in one recovery artifact.
4. In one entry-journal transaction, apply replacements, append the provider usage reset, and append the hidden `checkpoint-seal` completion marker.
5. Rebuild model context and reset provider/advisor replay state.

Transaction failure restores the prior entry graph and leaf; replay never observes shaken content without its completion marker.

The current inclusive `ShakeConfig.keepBoundaryId` MUST NOT be reused for checkpoint scoping because a missing ID silently widens to the full branch. Scoped Shake needs strict boundary resolution.

Image dropping remains out of scope for scoped sealing until image mutation supports entry boundaries.

## Todo behavior

Todo remains owned by the todo subsystem.

| Operation | Todo state after close |
| --- | --- |
| Rewind | State on checkpoint branch |
| Summary seal | Exact close-time durable snapshot |
| Shake seal | Existing close-time state |
| Keep | Existing close-time state |

A semantic seal SHOULD capture the current phases before branching and append a durable snapshot afterward. Existing replay strips completed and abandoned tasks during some navigation paths; seal restoration MUST preserve the close-time state required by the todo contract rather than silently losing terminal entries.

Recommended phase flow:

```text
todo phase starts
checkpoint opens
work and todo transitions proceed
phase is verified
todo phase completes
seal explicitly
next todo continues from close-time state
```

Todo completion MAY produce a UI suggestion when an associated checkpoint is open. It MUST NOT invoke seal automatically.

## Runtime quiescence

Summary seal and rewind MUST fail while the span has non-serializable pending control flow:

- incomplete tool call;
- pending apply/discard action;
- running background job or subagent;
- active debugger session;
- unfinished stream;
- unread authoritative steering;
- failed evidence persistence.

Shake seal may preserve live runtime state but MUST NOT elide content required to identify pending work. Keep remains available.

Process-memory jobs, tool-choice queues, yield queues, execution controllers, and message-delivery state are not restored from the journal. The implementation MUST NOT represent them as carried by summary sealing.

## Protected content

Summary sealing MUST preserve or safely rehydrate:

- system messages;
- developer messages;
- user messages;
- system directives and interrupts;
- approval decisions and unresolved pending actions;
- applicable skill/rule instructions;
- active goal state;
- prior seal and rewind reports;
- execution manifests;
- checkpoint lifecycle entries required for reconstruction.

Summary sealing rejects new user/developer messages and contextual entries that represent steering, approval, pending actions, IRC delivery, or `<system-directive>` content. Diagnostic notices and ordinary tool evidence may be summarized after quiescence and verification. A user MAY explicitly authorize consumption of one closure-only message by wrapping the entire message in `<checkpoint-seal-control>...</checkpoint-seal-control>`; messages containing `<system-directive>` remain protected. Deliberate general cross-yield spans remain out of scope.

Seal reports remain assistant-authored in provenance. They MUST NOT be inserted as synthetic user instructions. Manifest facts are runtime-generated and may use a distinct trusted wrapper.

## Execution manifest

A semantic report explains meaning. The runtime manifest records observed provenance. The assistant cannot edit manifest facts.

The full manifest SHOULD include:

- checkpoint/span IDs and timestamps;
- raw evidence URI;
- entries and estimated tokens before/after;
- tool-call success/failure/cancellation counts;
- known file create/modify/move/remove effects;
- opaque operations such as arbitrary shell/browser work;
- commands and exit codes;
- todo start/close snapshots and delta;
- active jobs/pending action at validation time;
- errors;
- generated artifacts;
- protected entries.

Active context receives a concise digest; the full manifest is stored as a session artifact or durable entry.

The manifest records execution, not semantic correctness. `command exited 0` does not become `requested behavior is correct`.

## Report contract

A summary report is a continuation handoff, not a diary.

- `outcome`: observably true result.
- `durableContext`: facts downstream work needs.
- `decisions`: durable decisions plus reasons.
- `verification`: exercised contract plus exact evidence.
- `remaining`: risks, gaps, intentionally deferred work.
- `next`: immediate continuation and inherited constraints.

Exclude play-by-play narration, obsolete hypotheses, routine reads, patch anchors, and generic success claims.

## Error handling

Every close failure MUST state:

1. why it failed;
2. whether the checkpoint remains open;
3. which close operations remain available;
4. whether active context changed.

Persistence failures MUST favor the original detailed branch. No partial compaction may become active.

## Tool prompts

### Checkpoint

Teach neutral boundary semantics:

- bounded investigation or productive phase;
- one active checkpoint;
- close with rewind, seal, or keep;
- no world rollback;
- close before yield;
- unavailable in subagents.

### Rewind

Teach rejected-trajectory semantics, start-time todo restoration, and surviving effects.

### Seal

Teach strategy choice:

- summary when the handoff can replace chronology;
- shake when decisions remain useful but payloads do not;
- verify stable outcomes first;
- retain unresolved risks;
- close-time todo state survives.

### Keep

Teach safe retention when interrupted, incomplete, uncertain, or detail-dependent.

Tool prompts describe agent decisions and failure recovery, not internal session functions.

## UI

The UI SHOULD show:

- open checkpoint goal;
- selected close disposition;
- seal strategy;
- entry/token compression estimate;
- changed-file and verification digest;
- todo state carried/restored;
- recovery link.

A semantic seal may render as a collapsed card with report, manifest, and detailed-branch actions. Rich rendering is optional for initial correctness; generic tool output must still expose the semantics.

## Compatibility

- Preserve `checkpoint({ goal })`.
- Preserve `rewind({ report })` and legacy `rewind-report` rehydration.
- Keep all lifecycle tools behind `checkpoint.enabled`.
- Keep tools top-level-only.
- Register new names in builtin names, factories, allowlists, discovery, and root tool docs.
- Existing saved transcripts and branches remain readable.
- Manual `/shake` and automatic Shake retain existing whole-history/latest-compaction behavior.
- Scoped Shake is invoked only by seal.

## Initial limitations

- one open checkpoint;
- no nesting;
- no deliberate cross-yield checkpoint;
- assistant-authored semantic reports;
- no automatic strategy;
- no automatic todo coupling;
- no semantic seal with active jobs/actions;
- no summary seal while goal mode is active;
- no scoped image dropping;
- no recursive seal-report summarization;
- no deletion of raw evidence.

## Verification contracts

Focused tests MUST prove:

### Lifecycle

- one active checkpoint;
- each disposition closes it exactly once;
- failed close leaves it open;
- keep permits a new checkpoint;
- terminal yield enforcement accepts every completed disposition;
- resume rehydrates open and completed states correctly.

### Rewind

- existing branch topology and provider context remain unchanged;
- todo rewinds;
- raw descendants remain;
- legacy persisted reports load.

### Summary seal

- eligible span leaves active context;
- report and manifest enter context with correct provenance;
- close-time todo survives branch rewrite;
- protected entries survive;
- detailed branch remains readable;
- provider/advisor sessions reset;
- partial persistence failure retains detailed branch.

### Shake seal

- pre-checkpoint entries are byte/deep equal;
- checkpoint entry remains;
- only post-checkpoint eligible content shakes;
- missing boundary fails closed;
- artifacts recover originals;
- already-shaken content is idempotent;
- rewrite failure rolls back mutations;
- provider context rebuilds.

### Keep

- branch and active messages remain unchanged except durable marker;
- close-time state remains;
- resume does not resurrect checkpoint.

## Rollout

1. Add durable keep and scoped Shake seal.
2. Dogfood boundary selection and state semantics.
3. Add summary seal with report, manifest, todo snapshot, and recovery branch.
4. Review the completed Bloomberg CLI experiment in `experiment.md`, `results.md`, `quantitative-analysis.md`, and `qualitative-analysis.md`.
5. Repeat across independently generated seals and additional task archetypes before changing the default.

## Decision rule

Preserve raw history as the safety default when trajectory detail is load-bearing. Offer report plus manifest explicitly under context pressure or branch fan-out. Use scoped Shake when chronology must remain visible or semantic sealing is unsuitable. Do not make semantic sealing automatic from this single task archetype; require broader task/seal evidence and evidence-calibrated finalization first.