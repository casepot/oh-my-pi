---
description: Prefer borrowed views over borrowed owned containers in Rust APIs.
condition: "\\bfn\\s+[A-Za-z_]\\w*\\s*(?:<[^>{}]{0,240}>)?\\s*\\([^)]*:\\s*&\\s*(?:String\\b|Vec\\s*<[^>]+>)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write a Rust API that accepts `&String` or `&Vec<T>`.

Before retrying the tool call, accept `&str` or `&[T]` instead, or add a short adjacent rationale when the function needs `String`/`Vec`-specific APIs. Do not repeat the same edit unchanged.
