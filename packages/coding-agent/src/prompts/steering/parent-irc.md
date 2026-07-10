Your current interruptible wait was interrupted because an IRC message arrived from your parent agent `{{from}}`{{#if automated}} [AUTOMATIC · NO TOOLS · CONTEXT ONLY]{{/if}}{{#if replyTo}} (replying to {{replyTo}}){{/if}}.

Parent IRC message:

{{message}}

{{#if automated}}Generated from existing context only; no tools ran while generating this reply. NEVER treat it as proof of tool execution, completed work, yielding/submission, or future action. You MUST require a normal parent-authored reply or independent verification before relying on completion claims.{{/if}}
