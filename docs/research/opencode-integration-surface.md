# OpenCode integration surface

Research for issue #3: what OpenCode exposes for embedding it in Loom's Electron main process.

## Which project and which version

OpenCode began as `sst/opencode`. The repository is now
[`anomalyco/opencode`](https://github.com/anomalyco/opencode): the GitHub API resolves
`sst/opencode` to `anomalyco/opencode`. The default branch is `dev`.

Two major lines ship at the same time, and they are **not API compatible**:

| Line | Packages | Status (2026-10-26) |
|---|---|---|
| **V2** | CLI `@opencode/cli` 2.1.4, network client `@opencode/client`, embeddable host `@opencode/sdk`, plugins `@opencode/plugin` | The `dev` branch. The README installs V2 (`opencode.ai/v2/install`, `npm i -g @opencode/cli`). Release notes are in `CHANGELOG.md` ("Release notes for OpenCode V2"). npm `latest` = 2.1.4 (2026-10-23). |
| **V1** | CLI `opencode-ai` 1.19.4, `@opencode-ai/sdk` 1.19.4 | Still released. GitHub tag `v1.19.4` (2026-10-22) is marked "Latest". Its source tree has the `packages/opencode` package, which no longer exists on `dev`. |

From the V1 migration guide: "OpenCode 1 and OpenCode 2 both use the `opencode` command and are no longer installed side by
side by default". V2 has three intentional breaking changes: a new plugin API, "new contracts" for the server API and
clients, and a new TUI config. Integrations that call the V1 server API "must migrate to the V2 API"
([migrate-v1.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/migrate-v1.mdx)).

**Loom should target V2.** This document covers V2. V1 is summarised in [section 11](#11-v1-summary-for-reference).

Sources read:

- `dev` branch at commit `cc4faf46bf09fe8b8469577f038272996c99d02d` (2026-10-26). Paths below are relative to the repo root.
- V2 docs come from `services/www/src/docs/content/`, which is published at `opencode.ai/v2/docs`.
- V2 design specs come from `specs/v2/`.
- The HTTP contract comes from `packages/protocol/src/groups/*.ts` and `packages/protocol/openapi.json`.
- Event shapes come from `packages/schema/src/*.ts`.
- V1 sources are from tag `v1.19.4`.

Link base: `https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/` (abbreviated `@dev/` below).

## Summary for the adapter design

| Concern | What OpenCode V2 provides |
|---|---|
| Embedding | Three modes. (1) **In-process host** `@opencode/sdk`: `OpenCode.create()` runs the server's HTTP router in memory, with no listener. (2) **Network client** `@opencode/client` against `opencode serve`. (3) The **shared background service**: `Service.ensure()` starts or adopts `opencode serve --service`. All three expose the same typed client. OpenCode's own Electron desktop app uses mode 3. |
| Event stream | One SSE feed per server, `GET /api/event`, across all directories. It is typed `AsyncIterable`s in the clients and can be filtered by `types`. It is live only, with no replay. A durable per-session log with replay is available: `sessions.log({ sessionID, after, follow })` (experimental). |
| "Finished" signal | `session.execution.succeeded`, `failed` or `interrupted`, and `session.status` → `{ type: "idle" }`. Polling: `GET /api/session/active` (busy sessions owned by this process) and `session.wait`. |
| "Asking the user" signal | A built-in `question` tool. It emits **`form.created`** (`form.replied` / `form.cancelled`), and the client answers with `POST /api/session/{id}/form/{formID}/reply`. Permission prompts emit **`permission.asked`**, answered with `.../permission/{requestID}/reply` (`once` / `always` / `reject`). MCP input requests also arrive as forms. |
| "Stuck" signal | No built-in detector. `session.status` `{ type: "retry", attempt, message, next }` and `session.retry.scheduled` report provider retries. `session.execution.failed` carries an error. An `"inactivity"` interrupt reason exists in the schema, but core does not emit it. Loom needs its own watchdog. |
| Permissions | The default policy is **allow everything** (except `.env` reads). Rules are ordered `{ action, resource, effect }` entries. **Per-session `permissions` can be passed to `session.create`.** |
| Custom tools | Plugins (`Plugin.define`, `ctx.tool.transform(editor => editor.add({...}))` with a JSON Schema or Standard Schema). They can be passed inline to `OpenCode.create({ plugins })`, loaded from `.opencode/plugins/`, or set in config `plugins`. MCP servers come from config `mcp.servers` or a plugin `ctx.mcp.transform`. Plugins can also expose typed RPC to the client. |
| Context injection | AGENTS.md discovery (global plus upward from the session directory, nested on read). Config `instructions` (files, globs, URLs). **Per-session API instruction entries** (`PUT /api/experimental/session/{id}/instructions/entries/{key}`, rendered as `<context key>` blocks). The `context` hook can edit the system prompt, messages and tools per request. The `prompt` hook can rewrite user input. Prompt `files` attach files. `synthetic` injects messages. |
| Persistence | SQLite. The CLI or service uses `$XDG_DATA_HOME/opencode/opencode.db` (override with `OPENCODE_DB`). The embedded SDK uses an **in-memory DB by default**; pass `database: { path }` to persist. There is crash recovery of in-flight executions, export and import, fork, and revert. |
| Working directory | **Multi-directory per server.** Every session has a `location: { directory, workspaceID? }`. Services (config, plugins, tools, MCP, LSP) are loaded per Location and unloaded after `location_idle_timeout` (60 min default). Sessions can be moved between directories. There is a first-class worktree API (`worktree.create/refresh/remove`). |
| Process lifecycle | In-process: `await using` / `close()`. Service: `Service.discover/ensure/stop`, a registration file, HTTP basic auth (`Service.headers`). Standalone: `opencode serve --port --hostname`, printing a generated password. |
| License | MIT (repository and all `@opencode/*` packages). |

**Recommended shape for Loom.** Run **one OpenCode server per Client**, not one per worktree, and give each Loom
Session one OpenCode session whose `location.directory` is that Session's worktree. Two hosting options:

- **(a)** `@opencode/sdk` in a Node `utilityProcess`. This gives full control, no port and no password, and Loom
  chooses the DB path. Note the native dependencies below.
- **(b)** A dedicated `opencode serve` child process that Loom spawns with a Loom-owned port, password and `OPENCODE_DB`,
  driven through `@opencode/client`.

Do not adopt the user's shared background service. Its sessions, config and DB would mix with the user's own OpenCode use.
Drive Working/Waiting from `session.status`, `form.*` and `permission.*` events on the single global SSE feed, filtered by
`sessionID`.

---

## 1. Integration modes

From [`build/index.mdx`](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/build/index.mdx), there are three ways to build on OpenCode: extend it (plugins), "run it as a server" (client), and "embed it" (SDK).

### 1.1 In-process host: `@opencode/sdk`

> `@opencode/sdk` hosts OpenCode directly inside your application. Unlike the network client, it assembles the OpenCode
> server and routes API calls through its HTTP router in memory. It opens no HTTP listener and adds no network hop.
> ([build/sdk/index.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/build/sdk/index.mdx))

```ts
import { OpenCode } from "@opencode/sdk"

await using opencode = await OpenCode.create({ plugins: [loomPlugin], database: { path: "/path/loom-opencode.db" } })
const session = await opencode.sessions.create({ location: { directory: "/path/to/worktree" } })
await opencode.sessions.prompt({ sessionID: session.id, text: "Review the current changes" })
for await (const event of opencode.events.subscribe()) { /* ... */ }
```

- It exposes "the full generated client" plus `sessions` and `events` aliases. Values, errors and streams are the same as
  in `@opencode/client`.
- "Embedded hosts are silent by default". Pass `log: { level, emit }` to receive logs.
  "Use a persistent `database.path` to recover Sessions after restart; the default database is in memory"
  ([packages/sdk/README.md](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/sdk/README.md)).
- `instances` selects different plugin sets per session from session `metadata`. The README calls this "not an
  authorization or storage-isolation boundary".
- **Runtime.** `@opencode/core` has `node`, `bun` and `workerd` export conditions. On Node, the database uses
  `node:sqlite` (`DatabaseSync`) and the PTY uses `@lydell/node-pty`, which is a native module
  ([packages/core/package.json](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/core/package.json),
  `src/database/sqlite.node.ts`, `src/pty/pty.node.ts`). In Electron this means node-pty must be rebuilt for Electron's ABI,
  and the bundled Node must provide `node:sqlite`. The docs show `bun add` but do not say whether Node or Electron is supported.
  **This needs a spike before Loom commits to option (a).** The V1 to V2 database migration is only implemented for Bun
  (`v1-migration.noop.ts` on Node).

### 1.2 Network client: `@opencode/client` + `opencode serve`

([build/client/index.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/build/client/index.mdx),
[cli/web.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/cli/web.mdx))

```ts
import { OpenCode } from "@opencode/client"
const client = OpenCode.make({ baseUrl, headers: { authorization: "Basic ..." } })
```

- `opencode serve --hostname --port` runs the server in the foreground and prints `server password <password>`.
  The server is "password protected" by default.
- It is browser compatible. Every operation accepts an `AbortSignal` and per-request headers.
- The HTTP API is versioned under `/api/...`. The OpenAPI document is at `packages/protocol/openapi.json`. The protocol
  definitions are in `packages/protocol/src/groups/`.

### 1.3 Shared background service

- `opencode` (TUI), the desktop app and the web UI share one per-user background server. Default ports are 49374 on
  macOS and Linux, and 28894 on Windows. It is configured with `opencode service set ...`.
- Node API from `@opencode/client/service`: `Service.discover()`, `Service.ensure({ file, version, command, onStart })`,
  `Service.stop()` and `Service.headers(endpoint)`.
- OpenCode's own **Electron** desktop app uses this mode. Its main process calls `Service.ensure` with
  `[cli, "serve", "--service"]`, a version predicate and a per-channel registration file, then requires
  `auth.type === "basic"`
  ([packages/desktop/src/main/service/background-service.ts](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/desktop/src/main/service/background-service.ts)).
  The renderer never sees the password, because the main process adds it to requests.
  This is a working reference for "Electron main process drives OpenCode".

## 2. Sessions and prompting

`POST /api/session` takes `{ id?, parentID?, title?, agent?, model?, location?, metadata?, permissions? }`
([protocol/src/groups/session.ts](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/protocol/src/groups/session.ts)).

- The caller can choose the session `id` ("Reusing a Session ID adopts the existing Session"). Loom can therefore derive
  it deterministically from the Loom Session.
- `metadata` holds arbitrary application data, for example the Loom Session ID, issue and branch.
- `POST /api/session/{id}/prompt` takes `{ id?, text, files?, agents?, skills?, metadata?, delivery?: "steer" | "queue", resume? }`.
  It "Durably admit[s] one session input and schedule[s] agent-loop execution unless resume is false". It returns the
  admitted inbox item. It does **not** wait for the run to finish. Use events or `session.wait`.
- Steering mid-run is native. `steer` (the default) is delivered at the next safe step boundary. `queue` waits until idle
  ([specs/v2/session.md](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/specs/v2/session.md)).
- Other operations:
  - `interrupt` (with optional `resume`), `fork`, `revert` (stage and commit), `compact`
  - `switchAgent` and `switchModel`
  - `command` (slash commands), `shell`, `synthetic` (non-user input), `generate` (transient text, no history change)
  - `diff`, `context`, `message(s)`, `inbox` (pending input), `move`, `view`
  - `experimental/session/{id}/export` and `/session/import`
- Subagents run as **child sessions** (`parentID`). Their events carry their own `sessionID`, so Loom must map child
  sessions to their root.

## 3. Event stream

`GET /api/event` is SSE, and the clients expose it as `client.event.subscribe({ types? })`.

- **One feed per server, across all Locations.** "The global cross-location event stream is intentional … The feed must
  not add request-location filtering"
  ([specs/v2/event-stream-architecture.md](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/specs/v2/event-stream-architecture.md)).
- The first frame is `server.connected`. There is a heartbeat every 15 s. Each connection has a 4,096-frame queue. A slow
  consumer that overflows is **disconnected** with `SubscriberOverflowError`, so the reader must buffer.
- "Subscriptions are live-only, with no replay or automatic reconnection … subscribe again after recovery". After a
  reconnect, resync from projections (`session.active`, `messages`, `form`, `permission`).
- For gap-free history, use `GET /api/experimental/session/{id}/log?after=&follow=true`. It returns durable events after a
  sequence number, then switches to live. Text, reasoning and tool-input deltas are not replayed (specs/v2/session.md).

Event types (from `packages/schema/src/session-event.ts`, `session-status-event.ts`, `form.ts` and `permission.ts`):

| Group | Types |
|---|---|
| Execution | `session.execution.started`, `.succeeded`, `.failed` (`error`), `.interrupted` (`reason: user \| shutdown \| superseded \| inactivity`) |
| Status | `session.status` with `status: { type: "idle" } \| { type: "busy" } \| { type: "retry", attempt, message, action?, next }`. `session.idle` is deprecated. |
| Steps | `session.step.started`, `.streamed`, `.ended`, `.failed`, and `session.retry.scheduled` |
| Text and reasoning | `session.text.started`, `.delta`, `.ended`, and `session.reasoning.*` |
| Tools | `session.tool.input.started`, `.delta`, `.ended`, `session.tool.called`, `.progress`, `.success`, `.failed` |
| Input | `session.inbox.enqueued`, `.delivered`, `.cancelled`, `.delivery.changed`, and `session.synthetic` |
| Interaction | `form.created`, `form.replied`, `form.cancelled`, `permission.asked`, `permission.replied`, `permission.rejected` |
| Lifecycle | `session.created`, `.updated`, `.deleted`, `.archived`, `.forked`, `.moved`, `.renamed`, `.agent.selected`, `.model.selected`, `.compaction.*`, `.revert.*`, `.instructions.updated`, `.usage.*`, `.diff`, `.error` |

## 4. Detecting Working and Waiting

| Loom status | OpenCode signal |
|---|---|
| **Working** | `session.status` `busy` (or `retry`), or `session.execution.started`. The session is listed in `GET /api/session/active`. |
| **Waiting: finished** | `session.status` `idle` after `session.execution.succeeded`. Check that the inbox has no pending `queue` items, because the runner keeps draining queued prompts. |
| **Waiting: failed or stuck** | `session.execution.failed` (`error`), `interrupted`, or a `retry` status. Loom adds an inactivity timeout, because core declares the `"inactivity"` reason but never emits it (it only appears in schema and generated clients). |
| **Waiting: asked a question** | `form.created` for the session. It comes from the built-in `question` tool (`packages/core/src/tool/plugin/question.ts`) or from MCP input requests. List pending forms with `GET /api/session/{id}/form`. |
| **Waiting: needs approval** | `permission.asked`. List with `GET /api/session/{id}/permission`. |

Notes:

- Forms and permissions arrive while execution is still "busy". Waiting must therefore come from pending forms and
  permissions as well as from status.
- The `question` tool is allowed for the `build` and `plan` agents and denied for `general`. The answer is fed back to
  the model as tool output ([permissions.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/permissions.mdx)).
- `session.view` and `session.viewed` mark an idle transition as seen. This could back Loom's "needs attention" badge.
- Execution is process-local. With a persistent DB, a restarted host resumes sessions that had in-flight claims
  ("Recovery is bounded … does not guarantee exactly-once provider requests or tool effects").

## 5. Permissions

([permissions.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/permissions.mdx))

- An ordered `permissions: [{ action, resource, effect: allow | ask | deny }]` list. The default base policy is
  `* * allow`, plus `ask` for `.env` reads. `external_directory` is **allowed by default** in V2, unlike V1.
- Replies are `once`, `always` (which saves a project-scoped allow rule) and `reject` (which rejects every pending request
  in the session).
- Rules can be set globally, per agent, **per session** (`session.create({ permissions })`), or through plugin hooks.
- Console-managed `policies` have final authority over everything else.

## 6. Custom tools, MCP and plugins

([build/plugins/index.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/build/plugins/index.mdx))

```ts
import { Plugin } from "@opencode/plugin"
export const loomPlugin = Plugin.define({
  id: "loom",
  async setup(ctx) {
    await ctx.tool.transform((editor) =>
      editor.add({
        name: "save_artifact",
        description: "Store a durable Artifact on the Loom Server",
        input: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] },
        execute: async (input, context) => ({ content: await saveArtifact(input, context.signal) }),
      }),
    )
  },
})
```

- **Plugin sources.** Inline objects in `OpenCode.create({ plugins })`, `opencode.plugin(p)` at runtime, the
  `.opencode/plugins/` directory (auto-loaded), or `plugins` in `opencode.json(c)` (npm packages or paths, with
  `options`). A plugin instance is per Location (`ctx.location`).
- **Tools.** `ctx.tool.transform` provides `add`, `update`, `remove` and `namespace`. Input is JSON Schema or Standard
  Schema. Executors receive `context.signal` and `context.progress()`. Each model request snapshots the tool set.
- **MCP.** Configured in `mcp.servers.<name>` as `local` (`command`) or `remote` (`url`, OAuth), with
  `timeout.catalog/execution` ([mcp-servers.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/mcp-servers.mdx)).
  Plugins change them with `ctx.mcp.transform(editor => editor.set(...))`. The HTTP API has `GET /api/mcp` and
  `/api/experimental/mcp/{server}/connect|disconnect`. MCP server instructions are added to the system prompt.
- **Hooks.** `ctx.session.hook("prompt" | "context" | "compaction" | "generate" | "title", ...)`, plus permission, shell
  and tool hooks.
- **Plugin RPC.** A plugin can expose typed methods and events that the client calls with `client.rpc(Def)`
  (`POST /api/rpc/{rpcID}/{method}`). This gives Loom's main process a typed channel into its own plugin.
- **Plugin agent and other surfaces.** Plugins can also define agents, commands, providers, skills, references, VCS and
  worktree strategies.
- V1 plugins do not run in V2.

## 7. Context injection

([instructions.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/instructions.mdx))

- **AGENTS.md.** The global `~/.config/opencode/AGENTS.md` loads first. Then every `AGENTS.md` from the session directory
  up to the project root is loaded, nearest first. Nested files below the directory are loaded when the agent reads that
  area. Changes are detected before the next model request and injected as an "instruction update".
  "OpenCode V2 recognizes `AGENTS.md` only. It does not use `CLAUDE.md` as a fallback."
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project discovery.
- **Config `instructions`.** Files, globs, `~/` paths or http(s) URLs, loaded after AGENTS.md.
- **Assembly order.**
  1. Agent or provider system prompt
  2. Code Mode guidance
  3. MCP, reference and skill guidance
  4. AGENTS.md, then configured instructions
  5. Date and environment context
  6. **Session-specific instruction entries supplied through the API**
- **API instruction entries.** `PUT/DELETE /api/experimental/session/{id}/instructions/entries/{key}` with a JSON `value`.
  Entries render as `<context key="...">` blocks, and changes are announced at the next step boundary
  without a new turn. This is the cleanest way to inject Loom **Project memory**, **User memory** and the linked issue
  per Session.
- **Request-level edits.** The `context` hook can push to `event.system`, edit messages or remove tools for each model
  call. Edits are not persisted.
- **Custom agents.** Agents, with their own prompt, model and permissions, are defined in config, in `.opencode/` files,
  or through `ctx.agent.transform`.
- **Files and messages.** Use prompt `files` (URIs) for attachments and `synthetic` for system-authored messages.

## 8. Session persistence

- SQLite (Drizzle). The CLI and service use `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`. Non-stable
  channels use `opencode-<channel>.db`. `OPENCODE_DB` overrides the path, and `:memory:` is allowed
  ([packages/cli/src/database-path.ts](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/cli/src/database-path.ts),
  [packages/util/src/global-roots.ts](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/util/src/global-roots.ts)).
- The embedded SDK uses an in-memory DB by default. Pass `database: { path }`.
- The model is event-sourced. Durable events are projected into tables (sessions, messages, inbox). The full transcript
  is kept even after compaction.
- Snapshots of the working tree back `revert`
  ([snapshots.mdx](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/services/www/src/docs/content/snapshots.mdx)).
- Sessions can be exported and imported as JSON (experimental), and listed with cursors and filtered by `directory` or
  project.

## 9. Working directory model

- **One server, many directories.** Each request runs in a Location. For a session operation, the Location is the
  session's saved placement. Otherwise it comes from the `x-opencode-directory` header, falling back to the server's cwd
  ([packages/server/src/location.ts](https://github.com/anomalyco/opencode/blob/cc4faf46bf09fe8b8469577f038272996c99d02d/packages/server/src/location.ts)).
  Config, plugins, tools, MCP and LSP are loaded lazily for each Location, and unloaded after
  `experimental.location_idle_timeout` (default 60 minutes; running sessions keep a Location loaded).
- A **Project** is the git repository and its canonical checkout. A Location (`directory`, `workspaceID?`) is a
  checkout or subdirectory of it. Different directories, such as worktrees, get separate plugin and service instances.
- **Worktrees are first-class.** `worktree.create({ projectID, name })`, `refresh` and
  `remove({ projectID, directory, force })` load config and plugins from the canonical checkout. Plugins can register
  custom worktree strategies. Loom can either let OpenCode create worktrees, or create them itself and just pass the path
  as `location.directory`.
- `session.move` moves a session to another directory at a delivery boundary.
- Sessions can create additional sessions with different directories in the same server. Loom therefore does **not**
  need one server per worktree.

## 10. Process lifecycle

| Mode | Start | Stop | Auth | Health |
|---|---|---|---|---|
| In-process SDK | `await OpenCode.create(opts)` | `await opencode.close()` or `await using` | none | `opencode.server.info()` |
| Dedicated server | spawn `opencode serve --hostname 127.0.0.1 --port N` (with `OPENCODE_DB`, `XDG_*` to isolate) | kill the process | HTTP basic, password printed on start (configurable) | `GET /api/info` |
| Shared service | `Service.ensure()` | `Service.stop()` | `Service.headers(endpoint)` | `Service.discover()` |

- Interrupting a session (`POST /api/session/{id}/interrupt`) keeps pending input. Shutdown interruption keeps the
  execution claim, so the session is recovered on the next start.
- Config auto-update (`update: "auto"`) "does not restart a running server". Loom should pin the OpenCode version it
  bundles.

## 11. V1 summary (for reference)

V1 (`opencode-ai` 1.19.4, `@opencode-ai/sdk`) has a similar shape with different contracts
(V1 docs: `packages/web/src/content/docs/server.mdx` and `sdk.mdx` on `dev`, or the tag `v1.19.4`):

- `createOpencode()` spawns `opencode serve` (default port 4096). `createOpencodeClient({ baseUrl })` connects to one.
  Optional password through `OPENCODE_SERVER_PASSWORD`.
- `/session/:id/message` (synchronous) and `/session/:id/prompt_async`. Events come from SSE `/event` (per instance)
  and `/global/event`, with `session.status` (`idle` / `busy` / `retry`), `message.part.updated` and
  `permission.*`. Permission replies go to `/session/:id/permissions/:permissionID`.
- `noReply: true` prompts inject context. Prompts also accept a per-request `system` field.
- V1 plugins (`@opencode-ai/plugin`, hook-based, `tool()` helper) are incompatible with V2.

Do not build on V1. V2 replaces its API, and the two cannot be installed side by side.

## 12. Licensing

MIT. The repository `LICENSE` reads "MIT License, Copyright (c) 2025 opencode", and the `@opencode/sdk`, `client`, `plugin`, `cli`, `core` and `server` package.json files
declares `"license": "MIT"`. Bundling the CLI binary or the SDK inside Loom is permitted with attribution.

## 13. Implications for a shared Pi + OpenCode adapter

Both agents fit a common interface. Compare with
[Pi findings](https://github.com/theholocoder/loom/blob/research/pi-integration-surface/docs/research/pi-integration-surface.md).

| Adapter operation | Pi | OpenCode V2 |
|---|---|---|
| `startSession(worktree, sessionId, context)` | `createAgentSession({ cwd })` | `session.create({ id, location: { directory }, metadata, permissions })` + instruction entries |
| `prompt(text, mode: steer\|queue)` | `prompt` / `steer` / `followUp` | `session.prompt({ text, delivery })` |
| `abort()` | `abort()` | `session.interrupt` |
| `events()`: Working / Waiting(reason) | `agent_settled`, retry events, Loom question tool | `session.status`, `execution.*`, `form.created`, `permission.asked` |
| `answer(questionId, answer)` | Loom-supplied UI context | `form/{id}/reply`, `permission/{id}/reply` |
| `registerTools(loomTools)` | extension `registerTool` | plugin `ctx.tool.transform` |
| `injectContext(key, value)` | `agentsFilesOverride`, `before_agent_start` hook | instruction entries / `context` hook |
| `resume(sessionId)` | open the JSONL session file | the session ID persisted in the SQLite DB |

Differences the adapter must absorb:

- OpenCode has **one process for many Sessions**, with a global event feed demultiplexed by `sessionID`. Pi has one
  in-process object per Session.
- OpenCode **has** built-in question and permission flows. For Pi, Loom must provide them. A Loom-owned question tool
  could be registered in both agents for uniform behaviour, or OpenCode's native `form.*` could be used.
- Neither agent detects "stuck". Loom owns an inactivity watchdog in both cases.
- OpenCode's default permissions are allow-all, like Pi's YOLO default.

## Open questions

- Does `@opencode/sdk` actually run inside Electron's Node (node:sqlite availability, node-pty rebuild)? If it does not,
  use a dedicated `opencode serve` child process. A short spike will settle this.
- How stable are the experimental endpoints Loom would rely on (`instructions/entries`, `session/log`, `session/wait`)?
  They are under `/api/experimental/` and may change between 2.x releases.
