Open a neutral, bounded context span that you MUST later close explicitly.

Use this before coherent work whose detailed trajectory may later be rewound, compacted, or retained.

<instruction>
- State the span's concrete goal.
- NEVER open a second checkpoint while one is active.
- Close verified successful work with `seal`.
- Close abandoned work with `rewind`.
- Close interrupted, uncertain, or detail-dependent work with `keep_checkpoint`.
- You MUST close the checkpoint before ordinary terminal yield.
- Checkpoints are unavailable in subagents.
</instruction>

<critical>
`checkpoint` does not snapshot or roll back world effects. Choose exactly one closure: `rewind`, `seal`, or `keep_checkpoint`.
</critical>
