Goal target plan approved.
{{#if contextPreserved}}
- Context preserved for raw evidence only. The approved execution summary supersedes earlier drafts, failed payloads, lint diagnostics, reviewer rejections, and payload repairs.
{{/if}}

<instruction>
You MUST execute the approved current target. Goal mode remains active.
You MAY implement only target `{{targetId}}` using plan `{{targetPlanId}}` revision `{{revision}}`.
Target-plan approval is not checkpoint completion.
Target completion is not parent completion.
{{#has tools "todo"}}
Before execution, initialize todo tracking from the approved execution summary if `todo` remains allowed.
After each completed step, immediately update `todo`.
If the summary lacks exact sequencing, read the plan file and initialize todos from the exact plan steps.
{{/has}}
Start from the approved execution summary. The plan file is a detail/recovery artifact:
- path: `{{planFilePath}}`
- hash: `{{planHash}}`
- bytes: `{{planBytes}}`
Read the plan only if exact file/symbol/command/recovery detail is missing from the summary.
{{#if executionSummary}}

<approved_target_execution_summary>
{{executionSummary}}
</approved_target_execution_summary>
{{/if}}
{{#if planDepth}}
- plan_depth: `{{planDepth}}`
{{/if}}
{{#if primarySignalGroupId}}
- primary_signal_group_id: `{{primarySignalGroupId}}`
{{/if}}
{{#if matrixRowCounts}}
- scenario_matrix: {{matrixRowCounts}}
{{/if}}
{{#if workstreamSummary}}
- workstreams: {{workstreamSummary}}
{{/if}}
{{#if implementationFanoutRequired}}
- Implementation fanout is recommended by summary metadata only if `task` remains allowed and you can split by workstream contract. NEVER spawn tasks automatically from this notice.
{{/if}}
Use target card/matrix summaries as execution guardrails; the plan file remains authority for exact details only when needed.
</instruction>

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />

<critical>
- Execute only the approved current target.
- Satisfy every required verification signal before checkpointing.
- Code/behavior changes require post-green code review before commit/checkpoint.
- Call `goal({op:"checkpoint"})` only after the closure standard is met with current evidence.
- NEVER call parent completion because this target plan was approved.
- Keep going until the target checkpoint is accepted or goal mode asks for another controller action.
</critical>
