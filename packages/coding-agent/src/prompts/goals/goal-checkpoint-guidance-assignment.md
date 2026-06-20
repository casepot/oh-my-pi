Prepare the controller-turn handoff for an accepted goal checkpoint.

Write a compact controller-turn handoff. The checkpoint closed one target; name what became true, what remains load-bearing, the next valid product-meaningful target, and the controller action required before ordinary work resumes.

<full_transcript_file>
{{contextFile}}
</full_transcript_file>

<goal_state_file>
{{goalStateFile}}
</goal_state_file>

<goal_state_snapshot>
{{goalStateSnapshot}}
</goal_state_snapshot>

<checkpoint_packet>
{{checkpointPacket}}
</checkpoint_packet>

Use read/search/find only. NEVER modify files. NEVER run tests/checks/linters/formatters/project-wide commands.

Analyze enough transcript/repo context to produce real guidance. You MAY inspect repeated rereads, review churn, record/code ratio, missing reviews, stale evidence, user corrections, target-aperture alignment, and code/evidence focus. Deep analysis is allowed; verbose output is not.

Orient toward implementation quality. Every recommendation SHOULD point to one of: code seam, evidence seam, review lens, product-signal boundary, stale-if anchor, or parent-frame delta. Do not create a process workstream. Do not make records, reviews, or self-improvement the next target unless domain closure rules require them inside the next valid target unit.

`continuationMessage` is the hidden prompt the main agent will read. Make it a compact staff-engineer handoff in this order:
1. `Action now`: exact `resolve_checkpoint` JSON.
2. `Bounded truth`: accepted/narrowed/rejected/not-claimed.
3. `Deliverables`: compact IDs plus changed status/evidence/blockers/next-target hints; no full rubric text.
4. `Next target`: one product-meaningful desired-future claim following project/domain target-unit rules.
5. `Code/evidence orientation`: first seams to inspect; refs to trust; stale-if anchors to reopen.
6. `Review posture`: lens and blocker definition for the next increment.
7. `Workstyle feedback`: what worked, next improvement, watchout.

It MUST say:
- parent goal remains active;
- previous target is closed only within evidence boundaries;
- ordinary work must not resume before `resolve_checkpoint`;
- parent changes require `resolve_checkpoint.parent_delta`;
- prose guidance does not mutate parent frame;
- domain records should be referenced, not copied;
- use compact deliverable-map IDs/statuses, not full rubric text;
- target-unit rules and product-signal boundaries govern the next target;
- targets are desired-future claims, not phase/checklist items;
- prefer `decision:"next_target"` while parent work remains;
- use `parent_completion_candidate` only for verifier confirmation;
- parent completion requires `goal({op:"complete"})`;
- `parent_completion_candidate` JSON must omit `next_target`;
- `next_target` JSON must include one valid target;
- `Action now` MUST use `decision:"next_target"` when parent work remains and one valid next target can be named.
- NEVER recommend `pause_for_external_control` unless the checkpoint packet or transcript names explicit user/operator/external authority that must act before `next_target`, `parent_completion_candidate`, `needs_user_input`, or `needs_broader_checks` applies.
- Unknown target preference is not external control; choose the highest-value valid next target from deliverables, frontier, residuals, or `remaining_parent_work`.
- release-increment projects need the next product-meaningful working release increment.

Controller outcomes: admit/narrow/reject checkpoint claims; start the next valid target unit; request input/checks; preserve lessons; select `parent_completion_candidate` only when verifier-ready.

Return structured output:
- `continuationMessage`: hidden prompt for the controller turn.
- `checkpointSummary`: concise target-closure summary.
- `controllerQuestions`: questions the controller must answer.
- `possibleNextTargets`: possible next desired-future targets.
- `broaderChecksOrInputs`: checks or external inputs to request.
- `parentDeltaConsiderations`: parent-frame claims/gates/boundaries/residuals/frontier to consider.
- `lessonsForFuture`: durable working-style lessons, not memory mutations.
- `avoidRepeating`: stale paths, overclaim risks, or productivity traps.
