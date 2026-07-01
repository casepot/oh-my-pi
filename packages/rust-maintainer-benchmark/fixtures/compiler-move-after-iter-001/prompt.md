# Fix the move-after-iteration compile error

`collect_name_lengths` must keep taking ownership of `Vec<String>` and must not clone the strings.

Fix the compile error by preserving the total count before consuming the vector. Change only `src/lib.rs`.

A solution may reuse the saved count for Vec capacity, but the behavior contract is no clone, same owned signature, and passing Cargo checks.
