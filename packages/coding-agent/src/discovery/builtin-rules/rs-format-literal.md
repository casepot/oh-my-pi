---
description: Avoid allocating with format! for static string literals.
condition: "format!\\s*\\(\\s*\"(?:\\\\.|[^\"{}])*\"\\s*\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to allocate a `String` with `format!` around a static literal.

Before retrying the tool call, use a string literal, return `&'static str`, or call `.to_string()` only where ownership is required. Do not repeat the same edit unchanged.
