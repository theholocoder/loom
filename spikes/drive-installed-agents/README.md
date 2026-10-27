# Spike: driving the installed Pi and OpenCode from Electron

Throwaway code for [Driving installed Pi and OpenCode from Electron](https://github.com/theholocoder/loom/issues/24). Not for reuse.

```bash
npm install
# headless: prints a JSON report and quits
npm start -- --dir <test git dir> --oc-model openai/gpt-6-luna-fast:low [--pi-model provider/id]
# with a window that streams both event feeds
npm start -- --dir <test git dir> --window
# OpenCode probes (plain Node, reusing agents.js)
node probes/concurrent.js "$PWD" <dirA> <dirB>   # two Sessions in two directories + interrupt
node probes/question.js "$PWD" <dir>             # question tool -> form.created -> reply
```

`report.json` is the report from a run launched with a desktop-like environment (`env -i … PATH=/usr/bin:/bin`).

## Tested versions

Electron 44.9.3 (Node 24.22.0) · Pi 1.4.0 · OpenCode 2.1.4 (V2) · Linux (Hyprland/Wayland).

## Findings

**Environment.** A desktop-launched app does not get the shell PATH: with `PATH=/usr/bin:/bin` neither `pi` nor `opencode` (both installed with mise) is found. Resolving the environment once at startup with `$SHELL -ilc 'env -0'` (as VS Code does) finds both in ~50 ms. Every child process (agents, `git`, `gh`, `glab`) gets that environment.

**Pi.**

- Install and version: look up `pi` on the resolved PATH, then run `pi --version` (prints `1.4.0`).
- Signed in: start a short-lived `pi --mode rpc` and call `get_available_models`. An empty list means no provider is signed in; a prompt then fails with `No API key found for the selected model`. `pi auth check` needs a provider name, so it can't answer "signed in at all?".
- Models: the same `get_available_models` call (`provider/id`, name, reasoning flag).
- Processes: one `pi --mode rpc --session-id <uuid> --session-dir <Loom dir>` per Session, with cwd set to the Session's worktree. It starts in about 0.4 s, and closing stdin shuts it down cleanly. If the parent is killed (SIGKILL), Pi exits too.
- Not verified: a real streamed Pi run, because no provider is signed in on the spike machine.

**OpenCode.**

- Install and version: look up `opencode` on the resolved PATH, run `opencode --version` (prints `opencode v2.1.4`), then read `GET /api/info` (`version`).
- Hosting: one private `opencode serve --stdio --hostname 127.0.0.1 --port 0` per Client, with `OPENCODE_SERVER_PASSWORD` set to a random secret. Requests use Basic auth `opencode:<password>`. The server prints `{"url":…}` on stdout and exits when its stdin closes, so it dies with Loom even on SIGKILL. Plain `serve` outlives its parent, including after a normal `app.quit()`.
- Don't run `opencode auth list` or `opencode models` for detection: they start the user's shared background service (`serve --service`). Query the Loom-owned server's API instead.
- Signed in: `GET /api/integration` lists at least one integration with `connections`. `GET /api/model` is not a usable signal, because the free OpenCode Zen models are listed even when signed out.
- A credential can be signed in and still unusable (no credit, free-tier limit). That only shows up as `session.step.failed` / `session.execution.failed` with a provider error.
- Models: `GET /api/model`, which returns `providerID/id`, name and `variants` (the reasoning levels). The list is per Location, so query it with `x-opencode-directory: <worktree>`. Two directories returned 47 and 75 models.
- Database: credentials live in the user's `opencode.db`. With `OPENCODE_DB` pointing elsewhere the server comes up signed out, so Loom must share the user's DB, and Loom's Sessions appear in the user's OpenCode session list. Loom-created ids are `ses_loom…`.
- Sessions: `POST /api/session {id, location: {directory}, model: {providerID, id, variant}}`, then `POST /api/session/{id}/prompt {text}`. The model is switched with `POST /api/session/{id}/model {model: {…}}`.
- Events: there is one global SSE feed, `/api/event`.
  - Two Sessions in two directories ran concurrently on one server.
  - Lifecycle comes from `session.execution.started|succeeded|failed|interrupted`. 2.1.4 emitted no `session.status` events.
  - `POST /api/session/{id}/interrupt` produces `session.execution.interrupted`.
  - Tokens and cost arrive in `session.usage.updated` and on `GET /api/session/{id}`.
- Questions: the built-in question tool emits `form.created`, with the session id at `data.form.sessionID` rather than `data.sessionID`. The answer is `POST /api/session/{id}/form/{formID}/reply {answer: {<fieldKey>: <value>}}`, which returns an empty body and resumes the run.
- Restart: stopping the server while a question was pending lost the in-flight run. After a restart the session had no pending form and was not active.
