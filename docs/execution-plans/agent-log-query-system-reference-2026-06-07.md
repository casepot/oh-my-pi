The simplest complete form:

> **Agent logs are an evidence graph for reconstructing what happened, what was known, what was attempted, what committed, and why a later decision is justified.**

Everything else is implementation detail.

## 1. Minimal ontology

```ts
RawEvent {
  id
  time | cursor
  type
  actorRef?
  runRef?
  sessionRef?
  stepRef?
  correlationId?
  causedBy?
  payload
  sourceLocator
}

Entity {
  id
  kind // run, session, actor, step, tool_call, artifact, decision, verification, observation
  attrs
  sourceLocators[]
}

Edge {
  from
  to
  relation // contains, step, called, produced, verified, changed, reported, caused, correlated
  sourceLocators[]
}

TraceEntry {
  stepRef
  seq
  method
  argsPreview | argsDigest
  resultPreview?
  error?
  durationMs?
  commitState // committed | attempted | rolled_back | unknown
}

TextUnit {
  id
  sourceRef
  actorRef?
  kind // reasoning, report, prompt, narration, error, claim
  text
  sourceLocator
}

ProjectionManifest {
  schemaVersion
  sourceFingerprint
  fresh
  complete | partial | failed
  verified
  problems[]
}
```

That is the core structure. Raw events remain source truth. Entities/edges/traces/text are navigational surfaces. Projections are useful only when their manifest says how trustworthy they are.

## 2. The query form

A complete query language does not need to be textual. The essential shape is:

```ts
LogQuery {
  root: RootSelector
  expand: ContextExpansion
  output: OutputShape
  evidencePolicy: EvidencePolicy
  limits: SafetyCaps
}
```

### RootSelector

Where the investigation starts:

```ts
RootSelector =
  | { entityId }
  | { eventId }
  | { runId | sessionId | stepId }
  | { timeWindow | cursorWindow }
  | { correlationId }
  | { causedBy | causalChainFrom }
  | { changedPath }
  | { verificationOutcome }
  | { observationKind | severity }
  | { textSearch }
  | { errorKind }
```

### ContextExpansion

What nearby evidence to pull:

```ts
ContextExpansion {
  graph?: { direction, depth, relationTypes }
  timeline?: { before, after, limit }
  trace?: { includeArgs, includeResults, includeErrors }
  text?: { kinds, limit }
  state?: { before?, after?, projections? }
  metrics?: { counts, coverage, latency, tokenUse }
}
```

### OutputShape

What the operator receives:

```ts
OutputShape {
  root
  primaryEntities
  supportingEntities
  edges
  events
  traceEntries
  textUnits
  sourceLocators
  stats
  caveats
}
```

### EvidencePolicy

What trust boundaries apply:

```ts
EvidencePolicy {
  requireFreshProjection
  requireVerifiedArtifacts
  allowPartial
  visibilityScope
  includeRolledBack
  requireSourceLocators
}
```

### SafetyCaps

Bound the answer:

```ts
SafetyCaps {
  maxEntities
  maxEdges
  maxEvents
  maxTraceEntries
  maxTextUnits
  maxRows
}
```

## 3. Complete understanding means answering six questions

For any run/session/agent behavior, “understood” means:

1. **What happened?**
   Ordered timeline of relevant events.

2. **Who or what did it?**
   Actor/session/step/tool/entity refs.

3. **Why did it happen?**
   Causal chain, not just correlation.

4. **What did the actor know or see?**
   Visibility boundary, prompt/context/tool results, queried state.

5. **What changed?**
   State/artifacts/mutations, with committed vs attempted vs rolled back.

6. **What proves the conclusion?**
   Source locators/raw rows/events, plus freshness/completeness caveats.

If one is missing, the analysis is partial.

## 4. The investigation workflow

Use this as the reference workflow:

```text
1. Integrity
   Check schema/version/projection freshness/event counts/trace coverage.

2. Orientation
   Get overview/status/counts before details.

3. Anchor
   Pick one root: entity, event, failure, changed path, verification, correlation, text hit.

4. Expansion
   Pull bounded graph/timeline/trace/text/state around the root.

5. Corroboration
   Check source locators/raw events/SQL rows.
   Prefer normalized trace over code/text parsing.

6. Interpretation
   Separate:
   - event order
   - causality
   - correlation
   - actor-visible knowledge
   - attempted vs committed state
   - evidence strength vs quality judgment

7. Decision
   Classify: retry, replan, publish, reject, continue, escalate, preserve knowledge.

8. Caveats
   State stale/partial/unverified/legacy/rolled-back/visibility limits.
```

## 5. Load-bearing invariants

These are the parts that must not be weakened:

1. **Raw and derived are separate.**
   Derived query surfaces are navigation, not truth.

2. **Every derived claim must cite source evidence.**
   Locator, event id, SQL row, artifact path, trace entry.

3. **Correlation is not causation.**
   `correlationId` groups; `causedBy` explains.

4. **Text is testimony, not state.**
   Reasoning/report/narration can explain intent, but committed state comes from events/projections/mutations.

5. **Rollback is semantic evidence.**
   A failed step may contain useful trace evidence but no committed effect.

6. **Visibility matters.**
   Analysis must distinguish what the system knows from what the actor could see when it acted.

7. **Read questions must have read APIs.**
   Never mutate just to discover readiness or state.

8. **Progressive disclosure is mandatory.**
   Counts first, then focused detail, then raw escape hatch.

9. **Completeness is bounded, not infinite.**
   A query is complete when it returns enough evidence for the decision with explicit caveats, not when it reads every log.

## 6. Simplest reference sentence

If we need one compact formulation:

> A complete agent-log query system anchors an investigation in a specific event/entity/outcome, expands bounded context across timeline, causality, trace, text, and state, and returns source-cited evidence with freshness, visibility, completeness, and commit-status caveats.

That is the load-bearing structure.