# Migrate `total_label_len` to a slice parameter

`total_label_len` should accept a borrowed slice instead of forcing callers to pass `&Vec<String>`. This benchmark fixture intentionally starts from that restrictive API so the task can migrate it away.

Change the function signature to `pub fn total_label_len(labels: &[String]) -> usize` and update the in-crate caller so it no longer allocates with `.to_vec()`. Preserve behavior.

The existing tests include a direct array-slice call; make that compile without allocating a Vec.
