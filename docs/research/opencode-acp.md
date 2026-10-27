# Driving OpenCode per Session over ACP

Research for issue #35: can Loom run each Session as its own `opencode acp` process, an
[Agent Client Protocol](https://agentclientprotocol.com) agent over stdio, instead of one private
`opencode serve --stdio` per Client (issue #24)?

**Short answer: yes.** OpenCode 2.1.4's `opencode acp` covers what Loom needs. It handles questions,
approvals, per-Session MCP tools, context, usage and cost, interrupt, model, thinking and mode changes, and
resume. Three gaps remain:

- **No steering.** A second prompt during a run is rejected.
- **No caller-chosen session ids.**
- **About 400 MB of memory per Session.** Each `opencode acp` spawns its own private `opencode serve` child.

## Method and evidence levels

Each claim below is tagged with how it was established:

- **[ran]**: verified by running `opencode acp` (OpenCode 2.1.4, `opencode --version` → `v2.1.4`) in a throwaway git
  repo (`/tmp/loom-acp-research/scratch`) and speaking ACP JSON-RPC over stdio from a Python driver. Prompts
  used the free `opencode/deepseek-v4.1-flash-free` model (about 6 short prompts, cost reported as $0). Per-process
  config was injected with the `OPENCODE_CONFIG_CONTENT` environment variable, so the user's OpenCode config files
  were not touched. All test sessions were removed afterwards with `session/delete`.
- **[src]**: read in OpenCode's source at tag
  [`v2.1.4`](https://github.com/anomalyco/opencode/tree/v2.1.4) (commit `68bc26b7`). The ACP bridge is in
  `packages/cli/src/acp/` and the command is in `packages/cli/src/commands/handlers/acp.ts`.
  Link base: `https://github.com/anomalyco/opencode/blob/v2.1.4/` (abbreviated `@oc/`).
- **[spec]**: read in the ACP spec repo
  [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)
  at commit `60f7b31c` (2026-10-27). Schemas are in `schema/v1/schema.json` (stable) and `schema.unstable.json`,
  docs in `docs/protocol/v1|v2/`, proposals in `docs/rfds/`, and the changelog in `docs/updates.mdx`.
  Link base: `https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/` (abbreviated `@acp/`).
- **[unknown]**: not established.

## What `opencode acp` actually is

- **Two processes per `opencode acp`.** [src][ran] The command starts a **private standalone server**, a child process
  running `opencode serve --stdio --port 0` with a random password, and bridges ACP to that server's HTTP API with
  the normal `@opencode/client` ([`@oc/packages/cli/src/commands/handlers/acp.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/commands/handlers/acp.ts),
  [`@oc/packages/cli/src/services/standalone.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/services/standalone.ts)).
  It does **not** use the user's shared background service. In practice one ACP agent equals one private
  OpenCode server plus a bridge, which is the issue #24 setup multiplied by the number of Sessions.
- **Protocol version.** [ran] It speaks ACP **v1** only. `initialize` with `protocolVersion: 2` gets `protocolVersion: 1` back.
- **Advertised capabilities.** [ran] `initialize` returns:
  - `loadSession: true`
  - `mcpCapabilities {http: true, sse: false}`
  - `promptCapabilities {embeddedContext, image}`
  - `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`
  - `_meta["opencode/child-session-updates"]` (sub-agent updates arrive as an `opencode/session/child_update` extension notification)
- **Lifetime.** [ran] Closing stdin exits both processes immediately: 4 processes closed in 0.04 s, with no leftover
  `serve` children. After a `kill -9` of the `acp` process, its `serve` child exited within about 5 s, because the
  `serve` process treats EOF on its stdin as the end of its lease. Startup is 0.25 s to `initialize` and about 0.4 to
  0.9 s to a ready `session/new`.

## Answers to the ticket's questions

### Waiting states: questions and approvals

- **Approvals arrive as standard `session/request_permission`.** [ran][src] OpenCode `permission.asked` events become
  `session/request_permission` requests.
  - **Request.** It carries a `toolCall`: name, title, kind, `locations`, `rawInput`, and for edits a `diff` content block
    with `oldText`/`newText`. The options are fixed: `once` (allow_once), `always` (allow_always), `reject` (reject_once).
  - **Example.** A `write` of `a.txt` under an `edit: ask` rule produced exactly that request. Answering `once` let the
    write proceed ([`@oc/packages/cli/src/acp/permission.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/permission.ts)).
  - **On cancel.** Pending asks are answered `reject` [src].
- **The question tool arrives as ACP form elicitation, `elicitation/create` with `mode: "form"`.** [ran][src]
  - **Example.** The `question` tool asked "Pick a color". It arrived as a form whose `requestedSchema` had a `oneOf`
    select (`q0`), a free-text `q0_custom` ("Type your own answer"), and the `toolCallId` of the question tool call.
    Replying `{action: "accept", content}` fed the answer back to the model
    ([`@oc/packages/cli/src/acp/elicitation.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/elicitation.ts)).
  - **Loom must advertise the capability.** [src] A client that doesn't set `clientCapabilities.elicitation.form` gets
    **no question at all**: OpenCode cancels the form and tells the model *"The question couldn't be shown to the user
    in this client. Continue without an answer…"*. The same happens to forms that don't map to ACP's schema, such as
    credential-looking fields, conditional fields or external fields. Only the `question` kind and
    `websearch.provider` forms are elicited. Other forms, including MCP-originated ones, are cancelled [src].
- **Spec status.** [spec] Elicitation was stabilized in ACP v1 (`@acp/docs/updates.mdx`, "Elicitation is Stabilized").
  ACP v2 (still draft) adds a `requires_action` session state for "blocked on user action". OpenCode doesn't speak v2.
- **Fit for Loom.** A pending `request_permission` maps to Waiting (*approval*), and a pending `elicitation/create`
  maps to Waiting (*question*). Both are client-bound JSON-RPC requests, so "pending" is simply an unanswered request.
- **Approval policy (#22).** OpenCode's default policy is allow-all, so no approvals are asked by default [ran: a run
  with the default config asked nothing]. Loom can impose its policy per process through `OPENCODE_CONFIG_CONTENT`
  `{"permissions":[{action, resource, effect:"ask"}]}` [ran with `edit`]. That env var is merged with the user's config
  ([`@oc/packages/core/src/config.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/config.ts)).
  Loom then decides each ask itself.
  - **Gap: `bash` rule.** [unknown] An `action: "bash"` rule did **not** trigger an ask for a shell command; the action
    name for shell commands in V2 still needs to be confirmed.

### Loom's tools as per-Session MCP servers

- **Yes.** [ran][src] `session/new` (and `session/load`, `session/resume`, `session/fork`) accept `mcpServers`.
  - **Transports.** stdio (`command`, `args`, `env`) and `http` (`url`, `headers`) are supported. `sse` is rejected with
    *"Only stdio and HTTP MCP servers are supported"* [ran].
  - **Scope.** Each server is registered on the private server with `mcp.add`, scoped to the session's directory
    ([`@oc/packages/cli/src/acp/sessions.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/sessions.ts)).
    It is not written to the user's config [ran: checked config files and `opencode.db`].
- **Verified end to end.** [ran] A Loom-like stdio MCP server, `loom` with a `memory_read` tool, was spawned by OpenCode
  with the env Loom passed. It received `initialize` and `tools/list`, and its tool result ("PELICAN") reached the model.
  - **`ask_user`.** It could be an MCP tool that blocks until Loom answers, or Loom can rely on the built-in question
    tool, which already surfaces as elicitation.
  - **MCP elicitation.** MCP-originated forms are cancelled over ACP [src], so an `ask_user` MCP tool must not depend
    on MCP elicitation.
- **Caveat: tool calls are wrapped in `execute`.** [ran] OpenCode V2 exposes MCP tools to the model through a
  **code-mode `execute` tool**. Over ACP, the tool call shows as `name: "execute"`, `kind: "other"`, with
  `rawInput.code` = `return await tools.loom.memory_read({ id: "m1" })`, not as `loom.memory_read`. For Loom-specific
  cards (memory Undo, Artifact links), Loom should key off its own MCP server's side, which knows each call, rather
  than the ACP tool-call stream.
- **Per-process tool isolation.** Because each `opencode acp` has its own server, per-Session MCP servers can't leak
  between Sessions.
- **Spec direction.** [spec] An RFD proposes **MCP-over-ACP** (`"type": "acp"` servers whose calls travel over the ACP
  connection itself, `@acp/docs/rfds/mcp-over-acp.mdx`). That would remove the shim process. It is draft only, and
  `mcp_message` appears only in `schema.unstable.json`.

### Context: memory title index and instructions

- **No ACP-native system prompt yet.** [spec] `session/new` has only `cwd`, `mcpServers` and `additionalDirectories`.
  A `systemPrompt` field is an RFD (`@acp/docs/rfds/client-system-prompt.mdx`), present in `schema.unstable.json` only.
  OpenCode doesn't implement it [src: not read in `service.ts`].
- **Three working routes, all verified:**
  1. **`OPENCODE_CONFIG_CONTENT` `instructions: ["<path>"]`** [ran]. Loom writes a per-Session file (instructions plus
     memory title index) and passes the env var when spawning that Session's process. The model quoted the file's
     text verbatim. This is the cleanest: system-level, per process, and the user's files are untouched.
  2. **The MCP server's `instructions`** (from the MCP `initialize` result) [ran]. The model quoted Loom's MCP server
     instructions from its system prompt. This works without any OpenCode-specific mechanism.
  3. **Embedded `resource` blocks in `session/prompt`** [ran][src]. They become a `synthetic` "ACP embedded context"
     message ([`@oc/packages/cli/src/acp/turn.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/turn.ts)).
     The model used it. This is user-level rather than system-level, so it is good for per-prompt context, such as
     a refreshed memory index.
- **User setup stays loaded.** AGENTS.md and the user's own config, agents and MCP servers are still loaded [ran: the
  `mode` option listed the user's custom agents `redacteur`, `specification`, `code-review`].

### Usage and cost (#25)

- **Per turn.** [ran][src] The `session/prompt` response carries `usage` {`inputTokens`, `outputTokens`,
  `totalTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`} for the turn, including on cancelled turns.
  - **Spec status.** [spec] `PromptResponse.usage` exists only in `schema.unstable.json`
    (`@acp/docs/rfds/end-turn-token-usage.mdx` is Draft).
- **Per session.** [ran][src] At the end of each turn OpenCode sends a `session/update` `usage_update` with `used`
  (context tokens), `size` (model context limit) and `cost: {amount, currency: "USD"}`. The cost is the cumulative
  session cost, read from the server.
  - **Spec status.** [spec] Stable: "Session Usage Updates are Stabilized" (`@acp/docs/updates.mdx`).
  - **Free model.** [ran] With the free model, `cost.amount` was 0.
- **What Loom gets.** Tokens and cost per turn, both after the turn ends. There are no live mid-run usage events over
  ACP; the server-level `session.usage.updated` is not forwarded [src].
- **No per-model breakdown.** Model changes mid-Session need Loom to attribute each turn to the model selected at the time.

### Controls

- **Interrupt.** [ran] The `session/cancel` notification ended a running `sleep 25` bash call immediately. The tool call
  went to `failed`, and the prompt returned `stopReason: "cancelled"` in 0.02 s. The next prompt in the same session
  worked normally.
  - **Cleanup.** [src] Cancel interrupts the server session and waits up to 5 s for cleanup.
  - **Pending asks.** [src] Pending permission asks are answered `reject` and pending forms are cancelled.
- **Steering mid-run: not available.** [ran][src] A second `session/prompt` during a run fails with
  `-32603 "Session already has an active ACP prompt"`. That is ACP v1 semantics: one prompt per turn. Loom's
  "Steer" action (#7) can't go through ACP. Loom's queue still works: send the next message when the turn ends.
  - **Workaround.** The only way to steer is Stop followed by an immediate re-prompt.
  - **ACP v2.** [spec] v2's prompt lifecycle accepts prompts while work is running ("acceptance means insertion",
    `@acp/docs/protocol/v2/prompt-lifecycle.mdx`). It is still draft, and OpenCode 2.1.4 doesn't speak v2.
- **Model and thinking changes mid-Session.** [ran] Use `session/set_config_option`:
  - `configId: "model"` takes `provider/model` values (75 models were listed, from the user's own providers).
  - `configId: "effort"` (`category: "thought_level"`) takes `none|low|medium|high|xhigh|max|default`.
  - Both returned the updated `configOptions`.
  - Changes made in the OpenCode server are pushed back as `config_option_update` [src].
  - The model choice persists with the session: after `session/load` in a new process, the model was still the free
    one [ran].
- **Mode and agent selection.** [ran] Use `configId: "mode"` (`build`, `plan` plus the user's agents), or the legacy
  `session/set_mode`. The `available_commands_update` notification lists slash commands.

### Resume

- **`session/load` after a restart.** [ran] It worked in a brand-new `opencode acp` process:
  - It replayed the history as `session/update`s: user message, thought chunks, tool calls and updates, agent message.
  - It re-registered the passed `mcpServers`.
  - The model remembered the earlier conversation.
- **`session/resume`.** [ran] It attaches without replay (0 history updates). This suits Loom, which keeps its own
  transcript (#7). Both are stable in v1 [spec].
- **`cwd` must match.** [ran] Loading with a different `cwd` fails: *"session … does not belong to cwd"*.
- **No caller-chosen ids.** [ran][src] `session/new` returns an OpenCode-generated `ses_…` id. There is no field for
  one, and `_meta` is ignored. Loading an unknown id fails with *"session not found"*. Loom must store the returned id
  against its Session.
- **In-flight state is lost on restart.** As with issue #24, killing the process loses the in-flight run and any
  pending question or approval. [src] Turns live in the bridge process. Loom keeps treating its restart as *interrupted*.

### Credentials and visibility

- **Uses the user's own `opencode.db` and credentials.** [ran][src] `opencode acp` spawns its server with the inherited
  environment (`extendEnv: true`), so it uses the user's default `opencode.db` and their signed-in providers. All the
  user's providers were listed, with no extra auth.
  - **No separate database.** As found in #24, a separate `OPENCODE_DB` would start signed out.
  - **Auth method.** `authMethods` advertises only "Run `opencode auth login` in the terminal" (`opencode acp --login`).
- **Visible in the user's session list.** [ran] Every ACP session was written to the user's `opencode.db`
  (`session_v2`, directory = cwd), and `session/list` returned them. They therefore appear in the user's own OpenCode
  session lists, with titles like "New session - <timestamp>". `session/delete` removes them [ran].

### Cost of a process

All figures were measured on Linux.

- **Startup.** [ran] 0.25 s to `initialize`. A ready `session/new` took 0.4 s alone and 0.9 to 1.0 s each when 4
  started concurrently.
- **Memory.** [ran] RSS per Session was about **120 MB** for the `acp` bridge plus about **280 to 320 MB** for its
  private `serve` child, so **about 400 to 450 MB per Session**. Four Sessions used about 1.7 GB. Each process loads
  the full OpenCode runtime, the user's plugins and their MCP servers, so the user's own MCP servers are spawned
  once **per Session**.
- **Shared `opencode.db`.** [ran] 4 processes ran 4 prompts concurrently against the shared `opencode.db` with no
  errors. A fifth, unrelated `serve` process was already running on the machine at the time.
  - **[unknown]** Behaviour under heavy concurrent write load, and interplay with the user's own running TUI or
    service, were not stress-tested. OpenCode uses SQLite WAL (`opencode.db-wal` present).
- **Comparison.** Issue #24's design is one server for all Sessions: one runtime, user MCP servers loaded once per
  directory, and Locations unloaded after an idle timeout. Per-Session ACP multiplies the memory by the number of live
  Sessions. #7's idle-stop rule (stop the process after 10 min Waiting with nothing in flight, then
  `session/resume`) would bound this, because resume is cheap and verified.

### ACP as Loom's agent adapter interface

- **Plausible, but not as the whole interface.**
  - **What fits.** [spec] ACP v1 stable already covers most of #7's `AgentSession`:
    - `session/prompt` → prompt
    - `session/cancel` → interrupt
    - `request_permission` and `elicitation` → answer
    - `session/close` → close
    - `session/update` → events: text and thought chunks, tool calls, plans, `usage_update`
    - config options → model and thinking
    - `session/load` and `session/resume`
  - **Other agents.** [spec] The ACP agent list includes Claude Agent (Zed's `claude-agent-acp` adapter), Codex
    (`codex-acp`), Gemini CLI, OpenCode, and **Pi through a third-party `pi-acp` adapter**
    (`@acp/docs/get-started/agents.mdx`). So Claude Code and Gemini could plug in.
- **What Loom would still need beyond ACP v1:**
  - **Steering.** Not available in v1.
  - **Per-turn token usage.** Unstable.
  - **A system prompt or context.** Unstable or `_meta`; each agent has its own workaround, for example
    `claude-agent-acp`'s `_meta.systemPrompt`.
  - **Stuck detection.** Not available.
  - **Caller-chosen ids.** Not available.
  - **Approval-policy injection.** Agent-specific; for OpenCode, `OPENCODE_CONFIG_CONTENT`.
  - **Tool display.** Tool-call naming and kinds vary per agent, such as OpenCode's code-mode `execute` wrapper.
- **Recommendation.** Make ACP **one adapter implementation** behind Loom's own `AgentAdapter` interface, rather than
  replacing the interface:
  - An `AcpAdapter` drives any ACP agent.
  - Small per-agent "profiles" hold the extras: spawn command, env for context and policy, and quirks.
  - Loom's tools travel as an MCP server, which every ACP agent must accept over stdio [spec: `@acp/docs/protocol/v1/session-setup.mdx`, "All Agents **MUST** support the stdio transport"; stdio MCP is the
    baseline all agents must support].
  - Pi could stay on its native RPC, where steering exists, or go through `pi-acp`.

## Recommendation for #37 and the adapter

1. **Per-Session `opencode acp` is viable.** If the user's preference holds, adopt it:
   - **Spawn.** `opencode acp` with cwd = worktree and the resolved user env (#24) plus `OPENCODE_CONFIG_CONTENT` =
     `{"instructions":["<Loom session context file>"], "permissions":[<Loom policy rules>]}`.
   - **Initialize.** Set `clientCapabilities.elicitation.form` (**required**, or questions are silently skipped).
   - **Start.** `session/new` with Loom's stdio MCP shim in `mcpServers`, then store the returned `ses_…` id.
   - **After a restart or idle stop.** Use `session/resume`, which needs no replay.
2. **Accept or design around:**
   - **No Steer.** Drop the action for OpenCode, or implement it as stop and re-prompt.
   - **About 400 MB per live Session.** Rely on #7's idle-stop.
   - **Usage only at turn end.**
   - **Sessions visible in the user's OpenCode history.** The same as with #24.
3. **Still unknown:**
   - The `permissions` action name that gates shell commands.
   - Behaviour with many concurrent processes under real load.
   - How the user's own MCP servers behave when spawned N times.
   - Windows and WSL.

## Sources

- OpenCode `v2.1.4`:
  - [`packages/cli/src/acp/service.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/service.ts): capabilities, session methods, MCP filter
  - [`sessions.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/sessions.ts): MCP registration, model and mode switching
  - [`turn.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/turn.ts): prompt, cancel, one-prompt-per-session, `usage_update`
  - [`translate.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/translate.ts): `PromptResponse.usage`
  - [`permission.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/permission.ts)
  - [`elicitation.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/elicitation.ts)
  - [`config-option.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/acp/config-option.ts)
  - [`commands/handlers/acp.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/commands/handlers/acp.ts)
  - [`services/standalone.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/services/standalone.ts)
  - [`packages/core/src/config.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/config.ts) (`OPENCODE_CONFIG_CONTENT`)
  - [`packages/schema/src/config.ts`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/config.ts) (`permissions`, `instructions`)
  - [ACP docs page](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/web/src/content/docs/acp.mdx)
- ACP at `60f7b31c`:
  - [`schema/v1/meta.json`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/schema/v1/meta.json) and `meta.unstable.json`
  - [`docs/updates.mdx`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/updates.mdx) (stabilizations)
  - RFDs [`client-system-prompt`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/rfds/client-system-prompt.mdx), [`session-usage`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/rfds/session-usage.mdx), [`end-turn-token-usage`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/rfds/end-turn-token-usage.mdx), [`mcp-over-acp`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/rfds/mcp-over-acp.mdx)
  - [`docs/protocol/v2/prompt-lifecycle.mdx`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/protocol/v2/prompt-lifecycle.mdx), [`v2/migration.mdx`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/protocol/v2/migration.mdx)
  - [`docs/get-started/agents.mdx`](https://github.com/agentclientprotocol/agent-client-protocol/blob/60f7b31c/docs/get-started/agents.mdx)
- Local runs: the driver and MCP shim scripts are summarised above. Logs were kept in `/tmp/loom-acp-research/` and are
  not committed.
