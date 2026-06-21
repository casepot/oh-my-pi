Approved goal target plan reference.

<instruction>
Use this plan as authority for the current target only. It does not prove target closure or parent completion.
If current goal state no longer matches this target, ignore this reference and call `goal({op:"get"})`.
</instruction>

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />

Read the plan file only if recovery or execution needs exact file/symbol/verification detail.
