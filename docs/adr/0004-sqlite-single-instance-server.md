---
status: superseded by ADR-0006
---

# The Server stores everything in SQLite and runs as a single instance

The Server hosts one Team and never executes development work. Its writes are small and infrequent: Memory entry and Artifact edits, auth tokens, and batched usage pushes from Clients. So it persists everything in one SQLite database in WAL mode, and runs as a single process: one container plus a volume, backed up as a file copy or with Litestream. We considered PostgreSQL, which is the usual choice for team services and allows several Server replicas, but then every deployment would need a database server to run, for load a single SQLite file handles easily. Supporting both was rejected because it doubles migrations and tests. The cost is that the Server can't scale horizontally. To keep a later move to PostgreSQL a port rather than a rewrite, data access goes through a typed query builder (Kysely) with portable SQL.
