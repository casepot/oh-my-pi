---
description: Avoid blocking std::fs calls inside Rust async contexts.
condition:
  - "\\basync\\s+fn\\b[\\s\\S]{0,1600}\\bstd::fs(?:::(?:File|OpenOptions))?::(?:read|read_to_string|write|copy|metadata|canonicalize|create_dir(?:_all)?|remove_dir(?:_all)?|remove_file|rename|read_dir|open|create|new)\\s*\\("
  - "\\basync\\s+(?:move\\s+)?\\{[\\s\\S]{0,1600}\\bstd::fs(?:::(?:File|OpenOptions))?::(?:read|read_to_string|write|copy|metadata|canonicalize|create_dir(?:_all)?|remove_dir(?:_all)?|remove_file|rename|read_dir|open|create|new)\\s*\\("
  - "\\buse\\s+std::fs\\s*;[\\s\\S]{0,1600}\\basync\\s+fn\\b[\\s\\S]{0,1600}\\bfs::(?:read|read_to_string|write|copy|metadata|canonicalize|create_dir(?:_all)?|remove_dir(?:_all)?|remove_file|rename|read_dir)\\s*\\("
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: tool-only
---

You are about to write blocking `std::fs` I/O inside Rust async code.

Before retrying the tool call, use `tokio::fs`, move the blocking work into `spawn_blocking`, or add a short adjacent rationale for startup-only or deliberately blocking I/O. Do not repeat the same edit unchanged.
