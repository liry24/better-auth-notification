# Repository guide

- Use Bun and `bun run test` (Vitest), not Bun's separate `bun test` runner.
- Versions and compatibility ranges live in manifests and CI. Bun is pinned by `packageManager`.
- Tooling is adapted from `liria24/nuxt-files-sdk` at `fb6242a7bebb54f850d57aa937b6bc07ef0d2b97`.
- Keep one server-only `sendNotification` API for all recipient counts. Never give it an HTTP route.
- Use Better Auth's adapter and plugin schema. Database uniqueness, not an in-process lock, owns delivery idempotency.
- Notify hooks only after successful writes. Duplicate sends and no-op state changes do not replay hooks. Hook errors cannot undo persisted state.
- Scope every recipient HTTP read/write to the session user. Do not persist recipient context or expose account/session credentials.
- Keep client runtime imports separate from server code. In-flight responses from a previous user must not restore their data.
- Tests use real SQLite. Consumer tests install a tarball in a fresh project; release tests must exercise `NOTIFICATION_TARBALL` without rebuilding or changing its hash.
- Run `bun run check` before pushing. `ci-ok` directly requires all blocking jobs and accepts only success.
- Preserve the reference CI's SHA-pinned Actions, minimal permissions, CodeQL and exact-artifact release gate.
- The initial guarantee is SQLite with Better Auth 1.7.x, minimum 1.7.7. Do not claim support for other databases without running their integration tests.
