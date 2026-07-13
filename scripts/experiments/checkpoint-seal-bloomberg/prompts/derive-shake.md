<critical>
You are at the verified shared-phase checkpoint immediately before `keep_checkpoint`. Make no file edits, run no commands, and do not use subagents.
</critical>

Call `seal` exactly once with `strategy: "shake"`. Supply no semantic report. Preserve ordinary decisions and prose while allowing the runtime to artifact-elide only eligible content strictly after the checkpoint boundary.

<critical>
Your only tool call MUST be `seal(strategy="shake")`. After it succeeds, respond exactly `SEALED`.
</critical>
