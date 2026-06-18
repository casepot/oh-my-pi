---
description: Write formatted Rust output directly instead of pushing format! allocations.
condition:
  - "\\.push_str\\s*\\(\\s*&\\s*format!\\s*\\("
  - "\\.extend_from_slice\\s*\\(\\s*format!\\s*\\([\\s\\S]{0,240}?\\)\\.as_bytes\\s*\\(\\s*\\)\\s*\\)"
  - "\\.write_all\\s*\\(\\s*format!\\s*\\([\\s\\S]{0,240}?\\)\\.as_bytes\\s*\\(\\s*\\)\\s*\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to allocate an intermediate `String` only to append or write it.

Before retrying the tool call, use `write!` or `writeln!` against the existing `String`, byte buffer, or writer. Do not repeat the same edit unchanged.
