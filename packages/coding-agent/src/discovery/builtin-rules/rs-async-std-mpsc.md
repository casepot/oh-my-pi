---
description: Avoid std::sync::mpsc in async or Tokio code.
condition:
  - "(?:async\\s+fn|tokio::spawn|#\\s*\\[\\s*tokio::(?:main|test)\\s*\\])(?:[\\s\\S]{0,800}\\bstd::sync::mpsc\\b)"
  - "\\bstd::sync::mpsc\\b(?:[\\s\\S]{0,800}(?:async\\s+fn|tokio::spawn|#\\s*\\[\\s*tokio::(?:main|test)\\s*\\]))"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write async Rust code that uses `std::sync::mpsc`, which can block executor threads and bypass async backpressure.

Before retrying the tool call, use `tokio::sync::mpsc` or another async-aware channel, or add a short adjacent rationale for a deliberately synchronous boundary. Do not repeat the same edit unchanged.
