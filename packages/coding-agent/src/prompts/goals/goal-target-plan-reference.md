Approved goal target plan reference.

{{#if approvedPlanMarkdown}}
<approved_target_plan_markdown path="{{planFilePath}}">
{{approvedPlanMarkdown}}
</approved_target_plan_markdown>
{{/if}}

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" payload_path="{{payloadFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />

<execution_context>
{{#if planDepth}}
- plan_depth: `{{planDepth}}`
{{/if}}
{{#if primarySignalGroupId}}
- primary_signal_group_id: `{{primarySignalGroupId}}`
{{/if}}
{{#if matrixRowCounts}}
- scenario_matrix: {{matrixRowCounts}}
{{/if}}
{{#if parallelWorkstreamBatch}}
<parallel_workstream_batch>
{{parallelWorkstreamBatch}}
</parallel_workstream_batch>
{{/if}}
- payload_sidecar: `{{payloadFilePath}}`
</execution_context>

{{#if executionGuardrails}}
<approved_target_execution_guardrails>
{{executionGuardrails}}
</approved_target_execution_guardrails>
{{/if}}

<instruction>
Use the approved Markdown plan as authority for the current target only.
If `parallel_workstream_batch` is present, the harness has not spawned it automatically; call `task` yourself when fanout is safe.
Use the execution guardrails as structured guardrails, not a replacement for the plan.
If current goal state no longer matches this target, ignore this reference and call `goal({op:"get"})`.
</instruction>
