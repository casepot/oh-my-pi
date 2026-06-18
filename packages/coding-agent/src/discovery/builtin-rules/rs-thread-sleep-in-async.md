---
description: Use async timers instead of blocking thread sleeps in Rust async contexts.
condition:
  - "\\basync\\s+fn\\b[\\s\\S]{0,1200}\\b(?:std::thread::sleep|thread::sleep)\\s*\\("
  - "\\basync\\s+(?:move\\s+)?\\{[\\s\\S]{0,1200}\\b(?:std::thread::sleep|thread::sleep)\\s*\\("
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to block an async Rust executor with `thread::sleep`.

Before retrying the tool call, use `tokio::time::sleep(...).await`, move deliberate blocking work into `spawn_blocking`, or add a short adjacent rationale. Do not repeat the same edit unchanged.
