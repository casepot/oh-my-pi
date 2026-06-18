---
description: Require explicit safety documentation for Rust unsafe code.
condition: "\\bunsafe\\s*(?:\\{|impl\\b|fn\\b|trait\\b)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust `unsafe` code.

Before retrying the tool call, add a `// SAFETY:` comment for unsafe blocks or impls, add a `# Safety` doc section for public unsafe functions or traits, or add a short adjacent rationale explaining why existing safety documentation already covers this edit. Do not repeat the same edit unchanged.
