# Goal Verification Freshness

## Purpose

Goal mode should distinguish between a verification command that passed and a verification command that is still current after later target work. The system should never let a pre-edit green check survive compaction/checkpointing as if it were final evidence.

The narrow invariant is:

> A verification command is fresh only when it passed and no known goal-target mutation happened afterward.

This feature tracks freshness, not sufficiency. It does not claim a command proves the target complete.

## Observed Problem

A real goal-mode session showed this sequence:

1. A focused command such as `cargo check -p automation-adapter-sdk` passed.
2. The agent continued editing source/docs/test files afterward.
3. The session was still active, so no bad checkpoint was observed, but compaction could easily preserve “check passed” while dropping “then more edits happened.”

The desired durable state is:

```text
Verification freshness:
- cargo check -p automation-adapter-sdk: stale
  reason: target changed after this command
```

## Design Principles

- Sound over clever: if the system says `fresh`, that claim must be reliable.
- Conservative states: `fresh`, `stale`, and `unknown` are better than false precision.
- Freshness is non-blocking guidance; checkpoint/review still decides evidence sufficiency.
- Track only active goal-target execution/repair, not target planning edits.
- Avoid shell parsing beyond simple known verification command shapes.
- Avoid a dependency/test-coverage engine.

## State Model

Reuse `Goal.workEpoch`, which already exists but is not currently advanced by target work.

Add optional goal fields:

```ts
export type GoalVerificationCommandStatus = "passed" | "failed";
export type GoalVerificationFreshness = "fresh" | "stale" | "unknown";
export type GoalVerificationCommandKind = "test" | "typecheck" | "lint" | "format-check" | "build" | "check" | "other";

export interface GoalTargetMutationRecord {
	epoch: number;
	toolName: string;
	paths?: string[];
	reason: string;
	occurredAt: number;
}

export interface GoalVerificationCommandRecord {
	id: string;
	sequence: number;
	targetId?: string;
	targetPlanId?: string;
	targetPlanRevision?: number;
	command: string;
	cwd?: string;
	kind: GoalVerificationCommandKind;
	status: GoalVerificationCommandStatus;
	freshness: GoalVerificationFreshness;
	workEpoch: number;
	recordedAt: number;
	staleAt?: number;
	staleReason?: string;
	source: "main-agent" | "task";
}
```

Add to `Goal`:

```ts
lastMutation?: GoalTargetMutationRecord;
verificationCommands?: GoalVerificationCommandRecord[];
```

Keep only the latest bounded set of command records, e.g. 10.

## Freshness Semantics

### Mutation

A known target mutation increments `goal.workEpoch` and records `goal.lastMutation`.

A target mutation is only tracked when:

- goal mode is enabled;
- parent goal is active;
- a current target is active;
- run mode is `working-target` or `awaiting-verification-repair`.

Do not track implementation freshness while `planning-target` is active.

### Verification

A recognized verification command records the current `goal.workEpoch`.

- Passed command at current epoch: `fresh`.
- Passed command from older epoch: `stale`.
- Failed command: retained as failed history, not fresh evidence.
- Ambiguous command/activity: use `unknown` only when needed; do not over-noise phase 1.

## Tool Classification

### Verification commands

Classify synchronous successful `bash` commands only.

Recognize simple single-command forms, plus simple `cd dir && <verification>`:

- `bun test ...`
- `bun run test ...`
- `bun --cwd=<pkg> run test`
- `bun check`
- `bun run check`
- `bun --cwd=<pkg> run check`
- `bun run check:types`
- `bun run lint`
- `bun run typecheck`
- `cargo check ...`
- `cargo test ...`
- `cargo clippy ...`
- `cargo fmt --check`
- `cargo fmt --all --check`
- `biome check ...`

Reject/ignore complex shell forms containing newlines, semicolons, pipelines, redirections, or arbitrary command chains.

### Mutating tools

Known mutations:

- `write`: successful write, path from details/args.
- `edit`: successful edit with diff or per-file results.
- `ast_edit`: successful applied rewrite with replacements.
- `lsp`: successful `rename`, `rename_file`, or `code_actions` with `apply === true`.
- `resolve`: successful `action === "apply"`.
- `task`: conservative phase-1 handling; non-isolated working-target task completion can mark verification stale/unknown because subagents may have edited files.
- `bash`: classify only obvious mutators such as `cargo fmt` without `--check`, `biome format --write`, `bun run gen`, `rm`, `mv`, `cp`, `touch`, `git checkout`, `git reset`, `git apply`, `git merge`, `git rebase`.

Do not classify `eval` in phase 1.

## Integration Points

### Agent session

Add a private map in `AgentSession`:

```ts
#toolExecutionArgsById = new Map<string, { toolName: string; args: Record<string, unknown> }>();
```

- On `tool_execution_start`: store args by `toolCallId`.
- On `tool_execution_end`: retrieve/delete args and pass tool name, args, result, and error status to `GoalRuntime`.

Use this instead of `afterToolCall` so the tool result event remains ordered before freshness state updates.

### Goal runtime

Add:

```ts
export interface GoalObservedToolResultInput {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	isError: boolean;
	source?: "main-agent" | "task";
}

async recordObservedToolResult(input: GoalObservedToolResultInput): Promise<void>;
```

This method:

1. Returns unless the current goal/target/run mode is freshness-trackable.
2. Classifies mutation.
3. Classifies verification command.
4. Applies mutation first when applicable.
5. Appends verification record when applicable.
6. Bumps/persists goal state only when semantic freshness state changed.
7. Never throws outward; caller logs and continues.

### Rendering

Add a compact `verification_freshness` object to the goal context surface.

Render in `goal({op:"get"})`:

```text
Verification freshness:
  work epoch: 13
  latest mutation: edit packages/foo.ts
  - cargo check -p pkg: stale (target changed after this command)
  - bun test test/foo.test.ts: fresh
```

Checkpoint review should treat stale verification as warning evidence, not a hard tool-level blocker.

## Risks and Mitigations

### False freshness

Risk: opaque shell/eval/task changes files after a check but are not recognized.

Mitigation: wording says “fresh since last known target mutation”; classify obvious mutators; keep `unknown` available; do not claim target sufficiency.

### Noisy stale markers

Risk: read-only reviewer task marks verification stale.

Mitigation: non-blocking guidance; refine task classification later if data shows noise.

### State churn

Risk: every edit emits goal state updates.

Mitigation: track only active target execution/repair, cap records, and only persist when mutation/verification state changes.

### Planning noise

Risk: plan/payload edits stale implementation verification.

Mitigation: ignore freshness while `planning-target` is active.

### Async bash

Risk: async command completion bypasses normal tool result path.

Mitigation: skip async verification in phase 1; integrate async job completion later if needed.

## Implementation Steps

1. Add state/types/clone/normalize support.
2. Add pure verification and mutation classifiers.
3. Add `GoalRuntime.recordObservedToolResult`.
4. Wire `AgentSession` tool start/end args map to runtime.
5. Render freshness in goal context surface and `goal({op:"get"})`.
6. Add checkpoint-review prompt guidance only if needed.
7. Add tests:
   - classifier tests for verification commands and mutators;
   - runtime freshness transitions fresh → stale → fresh;
   - serialization round-trip;
   - session integration for tool start/end recording;
   - goal tool rendering.
8. Verify with focused tests and `bun --cwd=packages/coding-agent run check`.

## Non-Goals

- No hard checkpoint blocking.
- No full shell parser.
- No test coverage inference.
- No async bash support in phase 1.
- No eval mutation tracking in phase 1.
- No broad dependency graph or package ownership model.
