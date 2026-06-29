Goal target plan approved. Execute this approved current-target plan.

{{#if approvedPlanMarkdown}}
<approved_target_plan_markdown path="{{planFilePath}}">
{{approvedPlanMarkdown}}
</approved_target_plan_markdown>
{{/if}}

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" payload_path="{{payloadFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />

<execution_context>
{{#if contextPreserved}}
- Context preserved for raw evidence only.
{{else}}
- Fresh execution context: planning/reviewer transcript was removed from model context.
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
{{#if taskBatchScaffold}}
- task_batch_scaffold:
{{taskBatchScaffold}}
{{#if taskBatchScaffoldRequired}}
- First implementation action SHOULD be one `task` batch using `task_batch_scaffold` unless a concrete safety reason makes fanout unsafe. If you do not fan out, record why in goal/checkpoint evidence before serial work.
{{else}}
- A parallel workstream batch is available. Use the scaffold when fanout is safe; otherwise keep serial work aligned to the same workstream ids/contracts.
{{/if}}
{{/if}}
</execution_context>

{{#if executionGuardrails}}
<approved_target_execution_guardrails>
{{executionGuardrails}}
</approved_target_execution_guardrails>
{{/if}}

<instruction>
You MUST execute the approved current target. Goal mode remains active.
You MAY implement only target `{{targetId}}` using plan `{{targetPlanId}}` revision `{{revision}}`.
Target-plan approval is not checkpoint completion.
Target completion is not parent completion.
{{#has tools "todo"}}
Before execution, initialize todo tracking from the approved Markdown plan first if `todo` remains allowed.
Use the execution guardrails to check closure signals and fanout.
After each completed step, immediately update `todo`.
{{/has}}
Use target card/matrix summaries as execution guardrails; the approved Markdown plan remains authority.
</instruction>

<critical>
- Execute only the approved current target.
- Satisfy every required verification signal before checkpointing.
- If a workstream batch exists, integrate or replace every required workstream with equivalent serial evidence before checkpointing; checkpoint review will reject partial batch closure.
- Code/behavior changes require post-green code review before commit/checkpoint; use execution guardrails `reviewLenses` when present.
- Call `goal({op:"checkpoint"})` only after the closure standard is met with current evidence.
- NEVER call parent completion because this target plan was approved.
- Keep going until the target checkpoint is accepted or goal mode asks for another controller action.
</critical>
