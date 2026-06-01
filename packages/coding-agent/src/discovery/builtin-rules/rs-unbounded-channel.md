---
description: Avoid unbounded Tokio channels without a bounded-flow rationale.
condition:
  - "\\bmpsc::unbounded_channel\\s*\\("
  - "\\bUnbounded(?:Sender|Receiver)\\b"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust code that uses an unbounded Tokio channel.

Before retrying the tool call, either use a bounded channel with backpressure, or add a short adjacent rationale for why this path is bounded by shutdown, fanout, or another invariant. Do not repeat the same edit unchanged.
