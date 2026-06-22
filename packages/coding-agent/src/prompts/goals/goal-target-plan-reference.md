Approved goal target plan reference.

<instruction>
Use the approved execution summary as authority for the current target only. It does not prove target closure or parent completion.
If current goal state no longer matches this target, ignore this reference and call `goal({op:"get"})`.
</instruction>

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" payload_path="{{payloadFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />
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
{{#if implementationFanoutRequired}}
- fanout: recommended by approved summary metadata; NEVER spawn tasks automatically from this reference.
{{/if}}

Read the plan file only if exact file/symbol/command/recovery detail is missing from the summary.
Payload sidecar: `{{payloadFilePath}}`.
