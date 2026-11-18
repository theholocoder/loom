# Client state lives in one local SQLite database

With no Server (ADR 0006), all of Loom's state lives on the Client machine. It is kept in one SQLite database in WAL mode in Electron's `userData` directory, written only by the main process. That includes Projects and their checkout bindings, Sessions, the agent's session ids, Babysit state, approval grants, the message queue, settings, usage buckets and every Session's transcript events. Attachments are the only exception: they are stored as files next to the database and referenced from it. Access goes through Kysely over better-sqlite3, with migrations bundled in the app and tracked with `PRAGMA user_version`.

We considered keeping each transcript as an append-only NDJSON file, with SQLite only for indexes and usage. That would make transcripts easy to read by hand and keep large tool outputs out of the database. We rejected it because a Session's status and its transcript cards couldn't change in one transaction, and there would be two formats to migrate and two things to back up. A single database gives one migration story and one file to copy.

## Consequences

- Only one Client runs per machine (single-instance lock), so the database never has two writers.
- On Windows the database stays on the Windows side, even for Sessions in a WSL Environment. Nothing Loom stores lives in the distro except worktrees and the stateless bridge binary (ADR 0008).
- Migrations are forward-only, with a `VACUUM INTO` snapshot taken first. A Client that finds a newer schema refuses to start rather than read it.
- If better-sqlite3's prebuilt binary won't load on a supported Linux distro, the fallback is `node:sqlite` with our own Kysely dialect. Kysely keeps that swap a port, not a rewrite.

## Amendment: the node:sqlite fallback is in (#76)

better-sqlite3's Linux prebuild needs glibc 2.34, and Loom supports Linux back to RHEL 8 (glibc 2.28), where it doesn't load. Loom then opens the database with Node's built-in `node:sqlite`, which Electron's Node has. It isn't a Kysely dialect of its own: a small adapter gives `node:sqlite` the shape Kysely's `SqliteDialect` takes from better-sqlite3 (`apps/client/src/main/storage/sqlite.ts`). Both drivers open the same file the same way, so a database either one wrote opens in the other. better-sqlite3 stays the first choice wherever it loads. CI runs the packaged AppImage on Rocky Linux 8 to check the fallback takes over there.
