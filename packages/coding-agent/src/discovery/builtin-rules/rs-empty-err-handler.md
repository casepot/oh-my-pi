---
description: Do not silently discard Rust errors with empty Err handlers.
condition:
  - "if\\s+let\\s+Err\\s*\\([^)]*\\)\\s*=\\s*[^\\{;]+\\{\\s*\\}"
  - "Err\\s*\\([^)]*\\)\\s*=>\\s*\\{\\s*\\}"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to silently ignore a Rust error.

Before retrying the tool call, propagate the error, log it, collect it for batch reporting, or add a short adjacent rationale for an intentionally ignored best-effort failure. Do not repeat the same edit unchanged.
