# Pi integration surface

Research for issue #2: what Pi exposes for embedding it in Loom's Electron main process.

## Which project "Pi" is

Pi is Mario Zechner's coding agent. It started as `badlogic/pi-mono` and has moved to
[`earendil-works/pi`](https://github.com/earendil-works/pi). `badlogic/pi-mono` now
redirects there (GitHub API returns `full_name: earendil-works/pi`). The npm packages
were renamed from `@mariozechner/*` to `@earendil-works/*`.

- Agent package: `@earendil-works/pi-coding-agent` v1.4.0, which depends on
  `@earendil-works/pi-agent-core` (agent loop) and `@earendil-works/pi-ai` (provider layer).
- Sources read: repository `main` at commit `6c384aa30f619d7b28963f2bab24d8dacbe73cb6`
  (2026-10-26). In the links below, `docs/` and `src/` are relative to `packages/coding-agent/`.

## Summary for the adapter design

| Concern | What Pi provides |
|---|---|
| Embedding | An in-process TypeScript **SDK** (`createAgentSession()`), or a subprocess in **RPC** mode (`pi --mode rpc`) with a typed `RpcClient`. Print and JSON modes are one-shot. |
| Event stream | `AgentSessionEvent` events: `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `queue_update`, compaction and retry events, and **`agent_settled`**. |
| "Finished" signal | `agent_settled` (and `session.isIdle` / `waitForIdle()`). **Not** `agent_end`, because retries, compaction or queued messages can follow it. |
| "Asking the user" signal | Pi has no built-in ask-user tool. Questions come from extension UI dialogs (`ctx.ui.select/confirm/input/editor`). In the SDK the host supplies its own `ExtensionUIContext`; over RPC they arrive as `extension_ui_request` records. Loom has to supply its own question tool. |
| "Stuck" signal | No built-in detector. Available inputs: `auto_retry_start/end` (with `finalError`), `stopReason` `error`/`aborted`/`length` on the final message, `compaction_end.errorMessage`, `extension_error`. Loom adds its own timeout or heuristics. |
| Permissions | No approval before tool calls by default ("YOLO"). Gate them with a `tool_call` handler that returns `{ block: true }`. |
| Custom tools | Extensions: `pi.registerTool()` with a TypeBox schema, plus `pi.on(...)` hooks, commands and providers. In the SDK, pass them inline through `DefaultResourceLoader({ extensionFactories })`, or pass `customTools`. |
| Context injection | `systemPromptOverride`, `appendSystemPromptOverride`, `agentsFilesOverride` (virtual AGENTS.md), `before_agent_start` / `context` hooks, `prompt(text, { images })`, and `pi.sendMessage()`. |
| Persistence | Append-only JSONL tree, one file per session, under `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl`. Configurable with `sessionDir` / `SessionManager`, or kept in memory. |
| Working directory | One `cwd` per session. It scopes tools, context-file discovery and session grouping. It is **not** a sandbox. Pi does not create git worktrees; Loom creates the worktree and passes its path as `cwd`. |
| Providers and auth | Many providers. Credentials come from OAuth or API keys in `auth.json`, from environment variables, or at runtime through `ModelRuntime.setRuntimeApiKey()`. |
| License | MIT (all three packages). |

Recommended shape: use the **SDK in-process** in the Electron main process (or in a Node
`utilityProcess` for isolation). It gives complete typed access, lets Loom supply the
extension UI context, and avoids parsing JSONL. RPC plus `RpcClient` is the fallback when
Loom needs process isolation per Session. The packages are ESM-only (`"type": "module"`)
and require Node >= 22.19.0.

---

## 1. Integration modes

Pi has four CLI modes (interactive, print, JSON, RPC) plus the SDK. All of them share
"the same agent, sessions, resources, and tools"
([docs/cli-integration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)).

| Mode | Interface | Lifetime |
|---|---|---|
| Interactive | Terminal UI | Until exit |
| Print (`--print`) | Final text on stdout | One invocation |
| JSON (`--mode json`) | JSONL events on stdout | One invocation; does not accept later commands |
| RPC (`--mode rpc`) | JSONL commands in, responses and events out | Long-lived |
| SDK | `createAgentSession()` in a Node or Bun process | Host-controlled |

### SDK

Source: [docs/sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";
const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader, modelRuntime, tools });
const off = session.subscribe((event) => { /* ... */ });
await session.prompt("...");   // resolves when the run finishes, including auto-retries
session.dispose();
```

- An `AgentSession` owns one conversation, its model, tools, queues, compaction state and extension runtime.
- Prompting while a run is streaming requires `streamingBehavior: "steer" | "followUp"`; without it, `prompt()` rejects.
  `steer()` and `followUp()` exist as direct methods.
- `abort()` stops the run and waits for idle. `waitForIdle()` waits without aborting. `isStreaming` and `isIdle` are getters
  ([src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)).
- `createAgentSession()` accepts these injectable boundaries: `modelRuntime`, `model`, `thinkingLevel`, `settingsManager`
  (which can be in-memory), `sessionManager`, `resourceLoader`, `tools`, `noTools`, `excludeTools` and `customTools`.
- `AgentSessionRuntime` adds `newSession()`, `switchSession()`, `fork()` and `importFromJsonl()`. Each replaces the
  `AgentSession`, so subscriptions must be rebound afterwards.
- The CLI's built-in extensions (codemode, tool_search, MCP) are **not** loaded by SDK sessions unless the host adds them.

### RPC

Sources: [docs/rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md),
[docs/rpc-commands.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md).

- `pi --mode rpc [--no-session] [--session-dir ...] [--provider/--model ...]`. Commands go to stdin as JSONL; responses and events come back on stdout.
- Commands include `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `set_model`, `compact`, `bash`,
  `switch_session`, `fork`, `clone`, `get_tree`, `get_entries`, `set_session_name` and `export_html`.
- A `prompt` response only means the prompt was accepted (`data.disposition`: `started`, `queued` or `handled`). The client must wait for `agent_settled`.
- Framing caveat: split records on LF only. **Node `readline` is unsafe** because it also splits on U+2028 and U+2029.
- To shut down, close stdin. `RpcClient` (exported) spawns the child, correlates request IDs and offers `promptAndWait()`.

## 2. Event stream

Source: [docs/json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md),
which is canonical for both JSON and RPC. SDK events are the same `AgentSessionEvent` union, except that SDK
`message_update` events also carry cumulative `partial` snapshots.

- Run and turn events: `agent_start`, `agent_end { messages, willRetry }`, `agent_settled { aborted }`, `turn_start`
  and `turn_end { message, toolResults }`.
- Message events: `message_start`, `message_update { usage, assistantMessageEvent }` and `message_end { message }`.
  `message_end` is authoritative. The nested event types are `text_start/delta/end`, `thinking_start/delta/end` and `toolcall_start/delta/end`.
- Tool events: `tool_execution_start { toolCallId, toolName, args }`, `tool_execution_update { partialResult }` and
  `tool_execution_end { result, isError, durationMs }`. Nested calls carry `parentToolCallId`.
- Other events: `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`,
  `compaction_start/end`, `auto_retry_start/end`, `summarization_retry_*`, and the RPC-only `bash_execution_update` and `extension_error`.
- Assistant messages carry `stopReason` and `usage`, including cost
  ([docs/message-types.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md)).

## 3. Driving Working and Waiting

- **Working**: set on `agent_start`, or when `prompt()` is called with disposition `started`.
- **Finished, so Waiting**: set on `agent_settled`. The docs say explicitly that "`agent_end` is not a final-idle signal"
  ([docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)).
  `agent_settled.aborted` distinguishes a user abort.
- **Error, so Waiting**: the final assistant `stopReason` is `error`, `aborted` or `length`, or `auto_retry_end { success: false, finalError }`.
- **Asking the user, so Waiting**: Pi ships no ask-user tool. The only built-in channel is extension UI dialogs:
  - `ctx.ui.select/confirm/input/editor` block the tool or handler until they are answered. They can take an optional `timeout`.
  - In the **SDK**, `session.bindExtensions({ uiContext, ... })` lets the host provide its own `ExtensionUIContext`
    (`ExtensionBindings` in `src/core/agent-session.ts`). Loom can implement the dialogs as IPC to the renderer and flip the Session to Waiting while one is pending.
  - Over **RPC**, they arrive as `extension_ui_request { id, method, ... }` and are answered with `extension_ui_response`
    ([docs/rpc-extension-ui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)).
  - Loom therefore registers its own "ask user" tool, for example modelled on
    [examples/extensions/questionnaire.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts),
    with `exposure: "model-only"`, which the extension docs recommend "for tools that orchestrate other tools or ask the user".
    Alternatively, the tool can return `terminate: true` and Loom can treat the end of the run as Waiting.
- **Permission prompts, so Waiting**: Pi "does not ask for approval before every tool call"
  ([docs/security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)).
  If Loom wants approvals, a `tool_call` handler calls `ctx.ui.confirm()` and returns `{ block: true, reason }`.
  The extension docs show this pattern, using MCP-style tool `annotations` to decide which calls need approval.
- **Stuck**: nothing built in. Use a watchdog on time since the last event while `isStreaming`, plus the retry and compaction failure events above.

## 4. Custom tools and extensions

Sources: [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[examples/sdk/06-extensions.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts).

- An extension is a TypeScript module with `export default function (pi: ExtensionAPI)`. Pi loads it with `jiti`, so no build step is needed.
- It can be discovered from `~/.pi/agent/extensions/` or `<cwd>/.pi/extensions/` (the latter gated by project trust),
  given as `additionalExtensionPaths`, or supplied inline through `DefaultResourceLoader({ extensionFactories: [(pi) => {...}] })`.
- API: `pi.registerTool({ name, label, description, parameters /* TypeBox */, execute })`, `pi.on(event, handler)`,
  `registerCommand`, `registerProvider`, `registerMcpServer`, `sendUserMessage`, `sendMessage`, `appendEntry`, `setActiveTools`, and `pi.events` for messages between extensions.
- Hooks Loom can use: `before_agent_start` (prompt sections and tools), `context` / `context_with_system`, `tool_call`
  (authorize or mutate a call), `tool_result` (redact a result), `agent_before_settle` (append entries or continue once),
  and `session_start` / `session_shutdown`.
- MCP servers are supported through `.pi/mcp.json` or `pi.registerMcpServer()`. In the SDK, add `createMcpExtension()` yourself.
- Extensions run in-process with full OS permissions.

## 5. Context injection

- **System prompt**: `DefaultResourceLoader({ systemPromptOverride, appendSystemPromptOverride })`
  ([examples/sdk/03-custom-prompt.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)).
  On disk, the equivalents are `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`, which are trust-gated. Per run, `before_agent_start` can edit
  `systemPromptOptions` or replace `systemPrompt`.
- **Context files**: Pi walks up from `cwd` loading `AGENTS.md`, `CLAUDE.md` and `AGENTS.override.md`. These load **regardless of project trust**.
  `agentsFilesOverride` can add virtual files (for example `{ path: "/virtual/AGENTS.md", content }`) or remove files
  ([examples/sdk/07-context-files.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/07-context-files.ts)).
  This is a natural slot for Loom's Project memory and User memory.
- **Messages and files**: `prompt(text, { images })`; `pi.sendMessage()` for custom content stored in, and sent to, the model;
  skills (`.pi/skills`, `.agents/skills`) for instructions loaded on demand; and prompt templates.
- **Resource ownership**: a custom `ResourceLoader` lets the host own all discovery. An in-memory `SettingsManager` avoids user settings files.

## 6. Session and transcript persistence

Sources: [docs/session-format.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md),
[src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts).

- Sessions are persistent by default. Each one is an append-only JSONL file, `~/.pi/agent/sessions/--<cwd with / \ : replaced by ->--/<timestamp>_<uuid>.jsonl`,
  and its header records `cwd`. The format is at version 3, with automatic migration of older files.
- Entries form a tree (`id` / `parentId`). The active leaf defines the branch sent to the model. Entry types: message,
  model_change, thinking_level_change, usage, compaction, context_edit, branch_summary, custom, custom_message, label and session_info.
- `SessionManager.create(cwd, sessionDir?, { id })`, `open(path)`, `continueRecent(cwd)`, `inMemory(cwd)`, `forkFrom(...)` and `list(...)`.
  `--session-id`, or the SDK option, lets the host choose the session ID, so it can equal Loom's Session ID.
- The storage directory can be overridden with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting.
  Loom can point it at its own app-data folder.
- Compaction inserts summary entries; the original entries stay in the file. The `SessionManager` is authoritative:
  assigning `session.agent.state.messages` does not replace persisted context.

## 7. Working directory and worktree model

- `cwd` (an SDK option, or the process cwd for the CLI) selects project resource discovery, context files, session grouping
  and built-in tool paths (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `powershell` on Windows).
- It is **not** a security boundary: "it does not prevent commands from accessing other paths"
  ([docs/security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)).
  The recommended isolation is a container, VM or sandbox ([docs/containerization.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)).
- Pi has no worktree creation or branch management. It is worktree-aware only when loading context files: a linked
  worktree's own `AGENTS.md` shadows the main repository's copy (`src/core/resource-loader.ts`).
  So Loom creates `git worktree add <path> <branch>` per Session and starts the Pi session with `cwd: <path>`.
- Project trust: `.pi/settings.json`, `.pi/extensions` and similar are gated. In non-interactive and SDK use, the decision comes
  from `--approve` / `--no-approve`, a `project_trust` extension handler, `~/.pi/agent/trust.json`, or the `defaultProjectTrust` setting.
  Loom should decide this explicitly.

## 8. Model providers and auth

Sources: [docs/providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md),
[examples/sdk/09-api-keys-and-oauth.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts).

- Pi supports many providers: Anthropic, OpenAI, Gemini, GitHub Copilot, OpenRouter, Bedrock, Vertex, Azure, Mistral, Groq, xAI, DeepSeek, local llama.cpp and others.
  Custom providers can be added with `pi.registerProvider()` or `models.json`.
- Auth uses OAuth or device login (`/login`), or API keys. Credentials are stored in `~/.pi/agent/auth.json`, read from environment variables
  (for example `ANTHROPIC_API_KEY`), or loaded from a command.
- In the SDK, `ModelRuntime.create({ authPath, modelsPath })` relocates the credential store, and `setRuntimeApiKey(provider, key)`
  injects keys without writing files. That suits Electron `safeStorage`.
- `/login` OAuth is a TUI flow. Loom would need its own login UI, or would reuse an `auth.json` that the `pi` CLI already populated.

## 9. Licensing

MIT. The copyright reads "Copyright (c) 2025 Mario Zechner" in the root `LICENSE`, and `pi-ai`, `pi-agent-core` and
`pi-coding-agent` all declare `"license": "MIT"` in their `package.json` files. Embedding and redistributing is fine, provided Loom keeps the notice.

## Open points for the adapter

- Pin the version, because the API is still moving quickly (1.4.0; the packages were recently renamed).
- Confirm that the ESM-only packages and their native or WASM dependencies (`@silvia-odwyer/photon-node`, `quickjs-wasi`) bundle cleanly in Electron's main or utility process.
- Decide between the in-process SDK and one RPC child per Session, trading crash isolation against simplicity.
