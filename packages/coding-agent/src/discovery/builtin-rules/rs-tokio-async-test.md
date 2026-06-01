---
description: Use Tokio async test support instead of plain tests or ad hoc runtimes for Tokio async tests.
condition:
  - "#\\s*\\[\\s*test\\s*\\]\\s*[\\s\\S]{0,160}\\basync\\s+fn\\b"
  - "Runtime::new\\s*\\(\\s*\\)(?:[\\s\\S]{0,160})\\.block_on\\s*\\("
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust async test scaffolding that may bypass Tokio's test runtime support.

Before retrying the tool call, use `#[tokio::test]` or a deliberate configured runtime test with a short adjacent rationale. Do not repeat the same edit unchanged.
