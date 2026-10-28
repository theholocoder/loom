# Client state lives in one local SQLite database

With no Server (ADR 0006), all of Loom's state lives on the Client machine. It is kept in one SQLite database in WAL mode in Electron's `userData` directory, written only by the main process. That includes Projects and their checkout bindings, Sessions, the agent's session ids, Babysit state, approval grants, the message queue, settings, usage buckets and every Session's transcript events. Attachments are the only exception: they are stored as files next to the database and referenced from it. Access goes through Kysely over better-sqlite3, with migrations bundled in the app and tracked with `PRAGMA user_version`.

We considered keeping each transcript as an append-only NDJSON file, with SQLite only for indexes and usage. That would make transcripts easy to read by hand and keep large tool outputs out of the database. We rejected it because a Session's status and its transcript cards couldn't change in one transaction, and there would be two formats to migrate and two things to back up. A single database gives one migration story and one file to copy.

## Consequences

- Only one Client runs per machine (single-instance lock), so the database never has two writers.
- On Windows the database stays on the Windows side, even for Sessions in a WSL Environment. Nothing Loom stores lives in the distro except worktrees.
- Migrations are forward-only, with a `VACUUM INTO` snapshot taken first. A Client that finds a newer schema refuses to start rather than read it.
- If better-sqlite3's prebuilt binary won't load on a supported Linux distro, the fallback is `node:sqlite` with our own Kysely dialect. Kysely keeps that swap a port, not a rewrite.
