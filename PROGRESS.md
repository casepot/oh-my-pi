# PROGRESS

## Intent
- Keep automation that preserves explicit user/configured intent.
- Remove or gate ambient capability/model/provider expansion.
- Prefer lean, curated defaults over broad compatibility imports.

## Chosen minimal changes
- Keep project-level provider capabilities discoverable, but suppress user/home capability sources by default.
- Keep project `.omp` skills and project compatibility-provider skills available; require explicit opt-in for user/global skill sources.
- Load project MCP config by default, but not user/global MCP config; remove hidden Exa env mutation from filtered MCP configs.
- Keep same-model retry/auto-continue; gate compaction model fallback behind explicit configuration.
- Require explicit opt-in before subagents substitute the parent model for an unauthenticated configured model.

## Status
- Previous context-promotion removal retained.
- Adversarial review loops completed; follow-up fixes applied.
- Build, typecheck, and focused verification passing.
