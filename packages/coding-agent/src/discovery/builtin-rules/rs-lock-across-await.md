---
description: Avoid holding Mutex or RwLock guards across .await.
condition: "let\\s+(?:mut\\s+)?([A-Za-z_]\\w*)\\s*=\\s*[^;]{0,160}\\.(?:lock|read|write)\\s*\\(\\s*\\)(?:\\.unwrap\\s*\\(\\s*\\))?\\s*;(?:(?!drop\\s*\\(\\s*\\1\\s*\\))[\\s\\S]){0,800}\\.await"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust code that may hold a `Mutex` or `RwLock` guard across `.await`.

Before retrying the tool call, either drop or block-scope the guard before the await, copy out the needed value, or switch to an async-aware synchronization pattern. If the guard cannot live across the await, add a short adjacent rationale. Do not repeat the same edit unchanged.
