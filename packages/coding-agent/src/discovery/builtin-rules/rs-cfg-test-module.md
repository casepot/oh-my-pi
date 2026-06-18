---
description: Gate in-source Rust test modules with cfg(test).
condition: "(?:^[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+tests\\s*\\{|(?:^|\\n)(?![ \\t]*#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)\\s*\\][ \\t]*\\n)[^\\n]*\\n[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+tests\\s*\\{)"
scope: "tool:edit(src/*.rs), tool:write(src/*.rs), tool:edit(src/**/*.rs), tool:write(src/**/*.rs), tool:edit(**/src/*.rs), tool:write(**/src/*.rs), tool:edit(**/src/**/*.rs), tool:write(**/src/**/*.rs)"
interruptMode: tool-only
---

You are about to write an in-source Rust `mod tests` without `#[cfg(test)]` immediately above it.

Before retrying the tool call, add `#[cfg(test)]` directly above the test module or move integration-only tests under `tests/`. Do not repeat the same edit unchanged.
