---
description: Avoid accidental process-lifetime memory leaks from Box::leak.
condition: "\\bBox::leak\\b"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust code that may leak a heap allocation for the rest of the process with `Box::leak`.

Before retrying the tool call, either use owned data, `Arc`, `OnceLock`/`LazyLock`, or an explicit owner that frees on drop; or, only for a deliberate process-lifetime leak, add an adjacent rationale explaining why the leak is bounded and safe. Do not repeat the same edit unchanged.
