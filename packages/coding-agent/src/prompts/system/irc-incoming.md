<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (replying to {{replyTo}}){{/if}}{{#if automated}} [AUTOMATIC · NO TOOLS · CONTEXT ONLY]{{/if}}:

{{message}}

{{#if interrupting}}An agent sent this while you were waiting or working. Any active interruptible wait was stopped early so you can read it now.{{/if}}

{{#if automated}}Generated from existing context only; no tools ran while generating this reply. NEVER treat it as proof of tool execution, completed work, yielding/submission, or future action. You MUST require a normal agent-authored reply or independent verification before relying on completion claims.{{else}}{{#if autoReplied}}You are mid-task and eligible for a side-channel automatic reply attempt to `{{from}}`. Generation and delivery are not guaranteed. You MUST use the `irc` tool (`op: "send"`, `to: "{{from}}"`) when a normal agent-authored answer is required.{{else}}If a response is expected, reply with the `irc` tool (`op: "send"`, `to: "{{from}}"`) — you may finish your current step first. Nobody replies on your behalf.{{/if}}{{/if}}
</irc>
