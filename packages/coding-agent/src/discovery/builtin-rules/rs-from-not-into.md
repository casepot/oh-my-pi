---
description: Prefer implementing From over direct Into when coherence permits.
condition: "\\bimpl(?:\\s*<[^>]{0,120}>)?\\s+Into\\s*<"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write a direct Rust `Into` implementation.

Before retrying the tool call, implement `From` instead so `Into` is derived automatically, or add a short adjacent rationale when coherence or orphan rules block `From`. Do not repeat the same edit unchanged.
