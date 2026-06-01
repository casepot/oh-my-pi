---
description: Preserve source error chains instead of converting errors directly to strings.
condition:
  - "\\.map_err\\s*\\(\\s*\\|\\s*([A-Za-z_]\\w*)\\s*\\|\\s*\\1\\.to_string\\s*\\(\\s*\\)\\s*\\)"
  - "Err\\s*\\(\\s*([A-Za-z_]\\w*)\\.to_string\\s*\\(\\s*\\)\\s*\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write Rust error handling that may discard the source error chain by converting an error directly to `String`.

Before retrying the tool call, preserve the source with `?`, `map_err` into a typed/wrapped error, or `anyhow::Context`; or add a short adjacent rationale if this is a UI/API string boundary. Do not repeat the same edit unchanged.
