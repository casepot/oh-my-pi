Goal target plan approved.
{{#if contextPreserved}}
- Context preserved. Use conversation history when useful; this approved target plan is authority for this target.
{{/if}}

<instruction>
You MUST execute this target plan step by step. Goal mode remains active.
You MAY implement only the approved current target. Target-plan approval is not checkpoint completion.
Target completion is not parent completion.
{{#has tools "todo"}}
Before execution, initialize todo tracking with `todo` from the approved plan steps.
After each completed step, immediately update `todo`.
If `todo` fails, fix the payload and retry before continuing.
{{/has}}
The plan path is for subagent handoff only. You already have the plan; NEVER read it unless explicitly needed to recover lost injected context.
</instruction>

The approved target plan is injected below. Execute it now:

<target_plan path="{{planFilePath}}">
{{planContent}}
</target_plan>

<critical>
- Execute only the approved current target.
- Satisfy every required verification signal before checkpointing.
- Call `goal({op:"checkpoint"})` only after the closure standard is met with current evidence.
- NEVER call parent completion because this target plan was approved.
- Keep going until the target checkpoint is accepted or goal mode asks for another controller action.
</critical>
