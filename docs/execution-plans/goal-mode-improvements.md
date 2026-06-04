# Goal Mode Improvement Execution Plan

## Objective

Implement durable, stale-proof goal-mode improvements based on observed real sessions:

- Rubrics become evergreen completion contracts, not brittle snapshots.
- Verifier output becomes structured evidence, gates, and blockers.
- Completion attempts keep durable audit history while blind-retry limits remain useful.
- Continuation guidance becomes delta-focused and avoids rubric/objective duplication.
- Goal side agents use a strict read-only tool whitelist.
- Goal artifacts become easier to audit and less duplicative.

## Evidence From Sessions

- OMP goal session: repeated verifier rejections were useful and precise, but continuation memos repeated too much broad scope and active state lost rejected-attempt history after non-goal work.
- Agent Gateway 0.2.0 session: verifier correctly blocked closure on stale release truth, missing clone-reduction evidence, and stale parent-target wording, then verified after narrow fixes.
- Agent Gateway 0.2.1 session: release-specific rubric and verifier were strong positive examples.
- Side-agent transcripts showed `generate_image` exposed despite goal side-agent tools declaring only `read`, `search`, `find`, and `yield`.

## Implementation Plan

### P0: Correctness and auditability

1. Add durable verification history to goal state.
   - Preserve every verification attempt.
   - Keep consecutive failed-attempt count scoped to retries without intervening work.
   - Preserve latest verifier feedback for audit and UI after subsequent work.

2. Add structured verifier result fields.
   - Deliverable gate results.
   - Evidence checked.
   - Blocking gaps.
   - Continuation focus.
   - Score.

3. Make rubrics evergreen.
   - Prompt for stable deliverable IDs and stale-proof criteria.
   - Separate durable feature/quality requirements from volatile baseline facts.

4. Enforce strict goal side-agent tool whitelist.
   - Explicit `toolNames` must be exact for goal side agents.
   - Image/custom/extension tools must not auto-activate under strict mode.

### P1: Continuation quality and artifact quality

5. Use verifier continuation focus directly for normal rejections.
   - Run the compactor only as fallback when verifier focus is absent.
   - Keep hidden continuation content out of visible goal tool output.

6. Improve artifact details.
   - Include total attempts, structured fields, and generated/rejected timestamps.
   - Deduplicate persisted rubric/feedback artifacts using stable semantic keys.

7. Split side-agent usage accounting where practical.
   - Preserve total goal budget accounting.
   - Add fields for side-agent usage in verification history.

## Verification Plan

- Add focused runtime tests for durable history, retry reset semantics, and latest feedback retention.
- Add integration tests for structured verifier details, direct verifier continuation focus, compactor fallback, and strict side-agent tool options.
- Add tool/session tests that prove `generate_image` is not exposed under strict goal side-agent tool mode.
- Run focused goal tests.
- Run `bun check` for the coding-agent package.
- Run adversarial read-only review, apply refinements, then rerun focused gates.
