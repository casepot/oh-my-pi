# Migrate user ids to a `UserId` newtype across the workspace

Replace stringly typed user ids in `user-core` with a `UserId` newtype and migrate `user-app` callsites.

Use `UserId::new(value: impl Into<String>) -> Self` (constructor parameter only; do not implement the `Into` trait), `UserId::as_str(&self) -> &str`, and change `find_user` to accept `&UserId`. Do not leave a compatibility overload that accepts `String`.

Both crates have tests; migrate the workspace so all tests pass.
