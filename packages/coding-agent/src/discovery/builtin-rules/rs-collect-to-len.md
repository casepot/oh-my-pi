---
description: Avoid collecting iterators only to inspect length or emptiness.
condition: "\\.\\s*collect\\s*::<\\s*Vec\\s*<[^>]*>\\s*>\\s*\\(\\s*\\)\\s*\\.\\s*(?:len|is_empty)\\s*\\("
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to allocate a `Vec` only to inspect iterator length or emptiness.

Before retrying the tool call, use `.count()`, `.any(...)`, `.next().is_some()`, or keep the iterator lazy until a collection is actually needed. Do not repeat the same edit unchanged.
