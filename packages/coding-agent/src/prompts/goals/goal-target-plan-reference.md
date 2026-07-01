Approved goal target plan reference.


<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" payload_path="{{payloadFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" payload_hash="{{payloadHash}}" payload_bytes="{{payloadBytes}}" />

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

<approved_target_execution_contract>
{{executionContract}}
</approved_target_execution_contract>

<instruction>
Use the execution contract as the active authority for the current target only.
Read the approved Markdown plan or payload sidecar only when the contract says the missing detail is needed.
If `parallel_workstream_batch` is present, the harness has not spawned it automatically; call `task` yourself when fanout is safe.
If current goal state no longer matches this target, ignore this reference and call `goal({op:"get", view:"active_plan"})`.
</instruction>
