Goal target plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; this approved target plan is authority for this target.
{{/if}}

<instruction>
You MUST execute the approved current target. Goal mode remains active.
You MAY implement only target `{{targetId}}` using plan `{{targetPlanId}}` revision `{{revision}}`.
Target-plan approval is not checkpoint completion.
Target completion is not parent completion.
{{#has tools "todo"}}
Before execution, initialize todo tracking from the approved plan steps if `todo` remains allowed.
After each completed step, immediately update `todo`.
If goal run mode blocks `todo`, continue from the approved plan; do not retry `todo`.
{{/has}}
The plan file is authority when exact steps are needed:
- path: `{{planFilePath}}`
- hash: `{{planHash}}`
- bytes: `{{planBytes}}`
Read the plan only if recovery or execution needs exact file/symbol/verification detail.
</instruction>

<approved_target_plan_ref target_id="{{targetId}}" target_plan_id="{{targetPlanId}}" revision="{{revision}}" path="{{planFilePath}}" hash="{{planHash}}" bytes="{{planBytes}}" />

<critical>
- Execute only the approved current target.
- Satisfy every required verification signal before checkpointing.
- Call `goal({op:"checkpoint"})` only after the closure standard is met with current evidence.
- NEVER call parent completion because this target plan was approved.
- Keep going until the target checkpoint is accepted or goal mode asks for another controller action.
</critical>
