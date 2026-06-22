Creates files or intentionally overwrites whole files at specified path.

<conditions>
- Creating new files explicitly required by task
- Intentional full replacement when preserving existing content is not useful
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- Existing text files SHOULD use Edit/Replace when a targeted change is possible; whole-file overwrite is appropriate only for first creation or intentional full replacement.
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
