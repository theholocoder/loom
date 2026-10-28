# How T3 Code runs agents and git in WSL and remote environments

Prior art for the Loom bridge design. It follows [`wsl2-environment.md`](https://github.com/theholocoder/loom/blob/research/wsl2-environment/docs/research/wsl2-environment.md) (branch `research/wsl2-environment`). That note recommends one long-lived Loom bridge per distro, started through `wsl.exe --exec`, multiplexing JSON over stdio.

Researched 2026-10-28 on Linux. Nothing here was run on Windows. Sources:

- **T3 Code**: [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) at `886d8f6812` (2026-10-28), nearest tag `v0.1.4-nightly.20261028.3838`. Paths below are relative to that tree.
- **OpenCode Desktop**: `anomalyco/opencode` at tag `v2.1.4`.
- **Setup-WSL action**: `Vampire/setup-wsl` at `v7.2.0`.
- **Runner images**: `actions/runner-images` at `c87f6f636f` (2026-10-22).

Tags:

- **[src]**: read in source.
- **[doc]**: owner documentation, including the README and PR descriptions written by maintainers.
- **[issue]**: GitHub issue or PR discussion, including live measurements reported there.
- **[inference]**: my reading of the sources. Not confirmed.

## Summary

| Question | T3 Code's answer |
|---|---|
| WSL support? | Yes. It runs a **whole second T3 server inside the distro**, not a thin bridge. Windows Electron supervises it through one long-lived `wsl.exe --exec` and talks to it over **HTTP/WebSocket on TCP**, not stdio. |
| How is it shipped? | The Windows installer embeds the **Linux CLI release archive**: a Node SEA binary `t3` plus native `node_modules`, about 70 MB. It is copied into `~/.t3/wsl-runtime/sha256-<digest>/` inside the distro, with locking, digest checks and pruning. No Node is needed in the distro. A slower fallback runs the server from `/mnt/c` with the distro's own Node. |
| Abstraction? | **Fat.** An "environment" is a complete T3 server: providers, git, MCP, SQLite. The desktop holds a *pool of backends* (Windows primary, WSL, SSH or remote) and the UI connects to each one separately. There is no thin RPC host abstraction. |
| Env / PATH | Login-shell `PATH` is probed with `bash -l` or `bash -lc` through `wsl.exe` during preflight, then passed as `env PATH=… t3`. The server spawns agents by name. |
| Kill | Agents run `detached` (own process group) and are killed with `kill(-pgid)`, TERM then KILL. Optional `systemd-run --user --scope` cgroups. There is a ledger to reap orphaned `opencode serve`. |
| Server lifetime | The server polls `getppid()` every 2 s and exits when its launcher is gone. Killing `wsl.exe` does **not** kill the Linux server synchronously. This caused real "port/state already owned" bugs on restart. |
| MCP / approvals | The MCP server lives **inside the in-distro server**, at loopback `http://127.0.0.1:<port>/mcp` with per-session bearer tokens. ACP agents get a stdio shim, `t3 acp-mcp-bridge`. Approvals go through the provider protocols to the same server. Nothing crosses the VM boundary except the UI's WebSocket. |
| Git | Runs in the server, so inside the distro. Status polling is driven by subscriptions (fetch interval 30 s by default). There is one checkpoint per turn through a temporary `GIT_INDEX_FILE`, commit and hidden ref. |
| CI | **No WSL in CI.** A Windows test lane exists but is manual-only, and "nothing in the suite passes on Windows yet". WSL logic is unit-tested through stubbed layers and POSIX shell tests run on Linux. Real WSL validation is done by hand by contributors and reporters. |
| GitHub runners and WSL2 | The hosted `windows-2025` image lists "WSL (Default, WSLv2): 3.0.3.0". `Vampire/setup-wsl` tests both WSLv1 and WSLv2 on `windows-2022`, `windows-2025` and `windows-latest`. A user reports `wsl --install` (WSL2) working on GitHub's `windows-2025`. GitHub does **not** document nested virtualization, so treat WSL2 on hosted runners as works-today, not guaranteed. |

## 1. WSL support: a full server in the distro

**Shape [src].**
- In the Windows desktop app, `DesktopWslBackend` registers a second backend instance with `DesktopBackendPool`, with id `wsl:<distro>` (`apps/desktop/src/wsl/DesktopWslBackend.ts`).
- The instance is a full `apps/server`: the same server that runs natively on macOS and Linux and as the CLI `t3`.
- The launch command is built in `resolveWslStartConfig` (`apps/desktop/src/backend/DesktopBackendConfiguration.ts`):

```
wsl.exe -d <distro> --exec env PATH=<system>:<login PATH> <runtimeRoot>/t3 --bootstrap-fd 0
```

- **The bootstrap goes over stdin.** It is a one-line JSON envelope carrying the port, `host`, a desktop bootstrap token and secret, and observability settings. The code comment says: "wsl.exe drops extra file descriptors; deliver its bootstrap via stdin." The native Windows backend uses fd 3 instead (`DesktopBackendManager.ts`) [src].
- After the bootstrap, stdio is used only for log capture (`captureOutput: true`).
- The UI and the desktop reach the server over HTTP/WS on the port the desktop picked (`scanForWslPort`, from the primary's port + 1).

**History [issue].**
- [#2751](https://github.com/pingdotgg/t3code/pull/2751) (2026-06-27) introduced Windows and WSL backends running "side by side". It also added a "Run WSL only" mode, where the WSL server becomes the primary.
- Each project routes to the backend that hosts it.

**Networking was the main source of pain [src][issue].**
- The server binds `0.0.0.0` in WSL. The code comment: "wslhost loopback forwarding is unreliable on some Windows hosts; advertise the WSL IP instead". `getDistroIp` reads it with `hostname -I`.
- [#13738](https://github.com/pingdotgg/t3code/issues/13738) then showed the opposite failure. Corporate endpoint security dropped Windows→NAT-IP traffic while loopback forwarding worked, and the backend never became ready. The measurements: inside WSL 4 ms, Windows→127.0.0.1 81 ms, Windows→NAT IP "connection closed unexpectedly". The fix PR ([#13745](https://github.com/pingdotgg/t3code/pull/13745), open) probes both routes and prefers loopback.
- [#9056](https://github.com/pingdotgg/t3code/issues/9056) reports that the bind on `0.0.0.0` exposes the server on the tailnet and on eth0, while the UI says "Limited to this machine".
- [#26200](https://github.com/pingdotgg/t3code/issues/26200) (2026-10-27) reports readiness timeouts of about 2 minutes against `127.0.0.1`, then `EADDRINUSE` after a relaunch.
- **Lesson for Loom [inference]:** TCP across the VM boundary in either direction is the least reliable part of T3's design. Loom's stdio-only plan avoids this whole class of bugs.

**Shipping and versioning [src][doc].**
- **Build.** `scripts/build-cli-archive.ts` builds `t3-<version>-linux-<arch>.tar.gz`: a **Node SEA** executable `t3`, `client/`, and the external native `node_modules` (`node-pty` `pty.node`, etc.). The header says "Runtime archives must run without host Node, npm, or compilers."
- **Release.** `release.yml` builds the Linux archive once. The Windows desktop jobs embed "the same-arch Linux CLI archive as the WSL runtime" (`.github/workflows/release.yml` around l.586, `release-desktop.yml` l.455–587). It ships as `resources/wsl-runtime.tar.gz` plus a `.sha256` sidecar. The archive is validated at package time (`scripts/build-desktop-artifact.ts` `parseWslRuntimeArchiveMembers`, l.3466–3500). PR [#11511](https://github.com/pingdotgg/t3code/pull/11511) made the archive the WSL runtime.
- **Install.** `buildWslRuntimeInstallScript` in `DesktopWslEnvironment.ts`:
  - The desktop converts the archive's Windows path with `wslpath -u` and runs a `sh -s` script through `wsl.exe` with the script on stdin. The code comment: "wsl.exe re-escaping mangles quotes inside bash -lc scripts."
  - The script takes `flock` on `~/.t3/wsl-runtime/.<id>.install.lock` and checks the archive's SHA-256.
  - It extracts to a temp dir and checks that `./t3 --version` runs. It writes a ready marker containing the binary's sha256, then does an atomic `mv -T` to `~/.t3/wsl-runtime/sha256-<digest>`.
  - The ready check re-hashes `t3` to detect "a swapped or partially written executable".
  - `runtime_in_use` greps `/proc/*/cmdline` so it never deletes a runtime a live server is using.
- **Prune** (`buildWslRuntimePruneScript`) keeps the current runtime and the previous one, skips any runtime in use, and removes scratch dirs older than 2 h.
- **Invalidate.** If install checks pass but the launch probe fails, the ready marker is removed. Otherwise "each launch reuses the broken cache".
- **Why not run from `/mnt/c`.** [#5769](https://github.com/pingdotgg/t3code/pull/5769): "Launching the backend from WSL's Linux filesystem avoids repeated `/mnt/c` reads". The title claims this is "dramatically improving launch times".
- **Fallback.** If staging fails, it runs the "mounted server tree": `apps/server/dist/bin.mjs` read over `/mnt/c`, under the **distro's own Node**. It needs Node ≥ the engine range, which it finds through nvm, fnm, asdf, mise, volta, nodenv or linuxbrew (`REMOTE_NODE_ENV_SCRIPT` in `packages/ssh/src/tunnel.ts`). It also needs a loadable Linux `node-pty`, and a dev build can compile it with `npx node-gyp` (`ensureNodePtyImpl`).
- **Real-world breakage of the bundled binary [issue].**
  - [#14393](https://github.com/pingdotgg/t3code/issues/14393): the SEA needed `libatomic.so.1`, which Ubuntu 22.04 lacked. The fallback then died on a missing native module, and the app crash-looped (62 restarts in 13 min).
  - [#22186](https://github.com/pingdotgg/t3code/issues/22186): Windows ARM64 lacked the linux-arm64 native bindings.
  - [#8297](https://github.com/pingdotgg/t3code/issues/8297): a distro with automount disabled made `wslpath` conversion of the archive path fail.
- **Remote over SSH, for comparison [src].** `packages/ssh/src/tunnel.ts` `REMOTE_RUNNER_SCRIPT`:
  - The remote host downloads the *same* release archive with `curl` or `wget` from the release URL, verifies it against `SHA256SUMS`, and installs it to `~/.t3/runtime/versions/<version>`. The lock is a noclobber file holding the owner's PID.
  - It starts the server with `nohup … serve --host 127.0.0.1` and reaches it through `ssh -L` with `ExitOnForwardFailure=yes` and `ServerAliveInterval=15`.
  - So T3 has one in-environment artifact (the CLI archive) and two delivery paths: embedded for WSL, downloaded for SSH.

**Detection [src][issue].**
- `isAvailable` checks only that `%WINDIR%\System32\wsl.exe` exists.
- [#21038](https://github.com/pingdotgg/t3code/issues/21038): that stub exists on every Windows 11 install. Running `wsl.exe --list --verbose` then *triggers the Windows "install WSL" prompt* on machines without WSL. The fix skips probing while the WSL backend is off.
- Distros are listed with `wsl.exe --list --verbose`, with an 8 s timeout, and decoded by `parseWslDistroList` (`wslPathParsing.ts`).
- `preWarm` runs `wsl.exe -d D -- true` with a 30 s budget before launch, "so readiness cannot race its cold start" ([#21070](https://github.com/pingdotgg/t3code/pull/21070): "a cold WSL distro gets 30 seconds to boot instead of 10").

## 2. Process architecture

[src]
- **Electron main** (`apps/desktop`) does no agent or git work. It holds:
  - the `DesktopBackendPool`, where each instance is a supervised server process (`DesktopBackendManager`);
  - the shell-env probe;
  - WSL and SSH environment helpers;
  - IPC to the renderer.
- **Server** (`apps/server`, Node, Effect) is the "environment". It holds:
  - provider adapters: Codex `app-server` over JSON-RPC stdio, Claude through `@anthropic-ai/claude-agent-sdk`, OpenCode through `opencode serve` plus its SDK, generic ACP agents (`packages/provider-acp`), Cursor, Grok, Pi;
  - git/VCS (`apps/server/src/vcs`), checkpoints, terminals (node-pty), the MCP server, SQLite state and auth.
- **Agents** are children of the server.
- **Web UI and mobile** connect to N environments. Each is an `EnvironmentConnection` with phases `available | offline | connecting | reconnecting | connected | error | unsupported` (`packages/client-runtime/src/connection/presentation.ts`). They connect over WebSocket RPC, either directly or through a relay.

**The "environment" abstraction is fat [inference].**
- T3 never remotes individual operations (spawn, git, fs) across a boundary. It moves the *whole* server.
- That is the VS Code Remote model, and it fits T3 because T3 already had a standalone server, a CLI, a web client and remote pairing.
- **For Loom:** a thin bridge (spawn, kill, env, git, MCP relay) keeps the domain and state in Electron main. That is a deliberately different trade-off. T3's experience shows the costs of the fat model:
  - two SQLite states;
  - state-dir ownership locks (`serverOwnership.ts`, exit code 78);
  - double-counted usage across Windows and WSL ([#7858](https://github.com/pingdotgg/t3code/issues/7858));
  - auth and bootstrap token races ([#16826](https://github.com/pingdotgg/t3code/issues/16826), [#22951](https://github.com/pingdotgg/t3code/issues/22951));
  - port collisions with Windows ([#22961](https://github.com/pingdotgg/t3code/issues/22961)).

## 3. Login env / PATH, spawn and kill

**Env in WSL [src].**
- At preflight, `buildWslRuntimeProbeScript` runs `bash -lc '<node-env preamble>; printf resolvedPath:%s "$PATH"'` through `wsl.exe --exec sh -s`. It falls back to the plain `$PATH`.
- Only **PATH** is carried over. Launch uses `env PATH=/usr/local/sbin:…:/bin:<resolvedPath>`. The comment: "wsl.exe --exec omits the login-shell PATH needed to find provider CLIs and npm".
- Other variables reach WSL only through `WSLENV`. `WSL_FORWARDED_ENV_NAMES` lists `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the OTEL/T3 telemetry vars and others, merged into the user's existing `WSLENV` (`DesktopBackendConfiguration.ts` l.83–150).
- `T3CODE_HOME` is stripped "to keep the Linux backend from sharing the primary's Windows SQLite file".
- Known gap: [#5740](https://github.com/pingdotgg/t3code/issues/5740) reports that `SSH_AUTH_SOCK` is not inherited, so SSH-signed commits fail in WSL.
- `bash -l` is used rather than `$SHELL -il`. That is weaker than Loom's planned `exec "$SHELL" -ilc 'env -0'` [inference].

**Env natively [src].**
- `apps/desktop/src/shell/DesktopShellEnvironment.ts` runs `$SHELL -ilc <capture command>` for a fixed list of names (`LOGIN_SHELL_ENV_NAMES`). On macOS it falls back to `launchctl getenv PATH`. On Windows it uses PowerShell profile probes.
- The result is installed into the Electron process and passed down with `shellEnvironmentPrepared: true`, so the server skips its own `fixPath` (`apps/server/src/os-jank.ts`).

**Spawn and kill [src].**
- Agents are spawned with `detached: platform !== "win32"`, which gives each its own process group. Example: `packages/provider-opencode/src/server/OpenCodeRuntime.ts` l.531.
- They are stopped with `signalProcessGroup(pid, SIGTERM)`, then after 1 s `SIGKILL`. `signalProcessGroup` is `process.kill(-pid, sig)` (`packages/provider-core/src/server/processGroup.ts`).
- On Windows they use `child.kill` with `forceKillAfter`, and avoid npm `.cmd` shims because "npm's Windows shim lets the child escape libuv kill-on-close".
- **Optional cgroups** (`apps/server/src/process/agentScope.ts`, `packages/shared/src/AgentScope.ts`): when a systemd user manager exists, agents are wrapped in `systemd-run --user --scope --slice=app-t3code-agents-<hash>.slice`. The slice has memory high/max limits and an OOM policy. A scope captures all descendants, which is stronger than a PGID because it catches processes that call `setsid`.
  - If there is no systemd user manager, scopes are disabled: "Agent scopes are off: no systemd user manager". Under WSL this depends on `systemd=true` in `wsl.conf` [inference].
- **Orphan ledger.** `OpenCodeServerLedger` writes `{pgid, pid, startTime, port, owner}` per `opencode serve` under the state dir. A later server run reaps entries whose owner is dead, checking start time to avoid PID reuse.

## 4. Tools, MCP and approvals

[src]
- **One MCP server per T3 server**, at `http://127.0.0.1:<serverPort>/mcp`. The host is `127.0.0.1` when the server binds a wildcard (`McpSessionRegistry.ts` `getHttpMcpEndpointHost`). Each provider session gets a 32-byte bearer token, stored hashed, with a 24 h liveness window.
- How each agent connects:
  - **Codex** gets `mcp_servers.t3-code = {url, http_headers.Authorization}` in its thread config (`CodexAdapterV2.ts` l.1340).
  - **Claude** gets an SDK `type: "http"` MCP server (`ClaudeAdapterV2.ts` l.1718).
  - **OpenCode** gets a `type: "remote"` MCP server in `OPENCODE_CONFIG_CONTENT` (`provider-opencode/src/server/adapter.ts` l.960).
  - **ACP agents** get a **stdio** MCP server: `t3 acp-mcp-bridge`, with `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` in the env (`packages/provider-acp/src/server/adapter.ts` l.611–623). The bridge relays JSON-RPC lines to the HTTP endpoint (`apps/server/src/mcp/AcpMcpStdioBridge.ts`). Its header: "ACP mandates stdio MCP support; HTTP/SSE support varies." `bin.ts` takes a fast path for this subcommand so it doesn't add CLI start-up time to the first message.
- **Approvals** are not MCP. They go through each provider's native channel into the server: Codex `app-server` approval requests, the Claude SDK `canUseTool` (`ClaudeAdapterV2.ts` l.9394), ACP `session/request_permission`. The server pushes them to the UI over WS.
- **Crossing the VM boundary.** It doesn't. The agent, its MCP endpoint and the approval handling all live in the same distro, and only the UI's WebSocket crosses.
- **For Loom [inference].** The same split applies if the bridge serves MCP *inside* the distro: a Unix socket or a loopback port, plus a stdio shim like `acp-mcp-bridge` for ACP. Tool calls then become bridge messages to Electron main. T3 confirms that a stdio MCP shim is the portable choice for ACP agents.

## 5. Lifetime, cold start, reconnect and failures

**Supervisor [src]** (`apps/desktop/src/backend/DesktopBackendManager.ts`):
- Restarts back off exponentially, from 500 ms to a cap of 10 s.
- Readiness means HTTP `GET /.well-known/t3/environment` succeeds. Probes repeat while the process is alive. The comment: "Cold WSL boots across /mnt/c can exceed one probe budget".
- Preflight failures are typed `{reason, fatal, retryLimit}`. Transport failures (`timeout | spawn | process` of `wsl.exe`) are non-fatal, with retry limits of 12 for the toolchain and transient preflight and 2 for builds. Missing Node, a node-pty that won't load, or a bad engine version are fatal.
- `MAX_PREFLIGHT_FAILURE_ATTEMPTS = 5`.
- Exit code 78 (`SERVER_EXIT_CODE_STATE_DIR_OWNED`) stops restarts and shows a remediation message.
- Failures appear as `lastPreflightError` in the Connections settings for dual mode. In WSL-only mode they appear as a dialog plus a fallback to the Windows backend (#2751).
- [#14393](https://github.com/pingdotgg/t3code/issues/14393): a crash *after* preflight was not covered, which caused an endless splash screen and a crash loop. The fix is [#26063](https://github.com/pingdotgg/t3code/pull/26063), open.

**Server dies with its launcher [src].**
- `apps/server/src/launcherWatch.ts` polls `process.ppid` every 2 s. In desktop mode, any change ends the server like a SIGTERM would. This came from [#20277](https://github.com/pingdotgg/t3code/pull/20277).
- The server also ignores `EPIPE` on stdout and stderr once the launcher is gone (`apps/server/src/cli/server.ts`).
- It does **not** watch stdin EOF: stdin is read only for the bootstrap line, then closed.

**Killing `wsl.exe` does not stop the Linux server [issue].** [#22478](https://github.com/pingdotgg/t3code/pull/22478), open, has live measurements:
- "the app stops the WSL backend with taskkill /T /F against wsl.exe… the server runs inside the Linux VM, which isn't in that process tree".
- "The Linux server's parent is WSL's `/init` relay, not `wsl.exe`."
- On main, the replacement server failed with code 78 in 2 of 3 runs, because the old server's clean shutdown takes about 3 s.
- The proposed fix:
  - launch through `sh -c` so the script prints `t3code-wsl-server-process <pid> <starttime>` to stderr and then `exec`s the server;
  - to stop, run a second `wsl.exe --exec sh -s` script that checks `/proc/<pid>/stat` start time, sends SIGTERM, and waits up to 3 s;
  - kill `wsl.exe` only after that.

This independently confirms the prior note's inference: killing `wsl.exe` only hangs up the child, so stop must be signalled *inside* the distro.

**Reconnect [src].** The client keeps one connection supervisor per environment, with phases, route probing (2.5 s timeout, 500 ms head start for preferred routes) and reconnects (`packages/client-runtime/src/connection/driver.ts`). The desktop keeps a working route across backend restarts (#13745).

## 6. Git and diffs

[src]
- All git work runs in the server process, so inside the distro for WSL projects, through `VcsProcess` / `GitVcsDriver` (`apps/server/src/vcs/`). Each call is a plain `git` child process with a timeout and an output cap.
- On Windows it adds `-c core.longpaths=true`.
- **Status** comes from `VcsStatusBroadcaster`:
  - Subscriptions drive it: pollers exist only while a client watches a cwd.
  - Remote refresh and fetch run every `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = 30 s` (`packages/contracts/src/settings.ts` l.913). It is configurable, and on failure backs off from 30 s up to 15 min.
  - Local status is invalidated on events: turns, git actions.
- **Diffs** come from **checkpoints**. `GitVcsDriver.checkpoints.captureCheckpoint` (l.829) works as follows:
  - It writes the worktree into a temporary index (`GIT_INDEX_FILE=<commondir>/t3-checkpoint-index-<uuid>`, with fsmonitor and split-index off).
  - It commits that tree under a fixed `T3 Code` identity and stores it under a checkpoint ref.
  - The orchestrator captures one at turn boundaries (`apps/server/src/orchestration-v2/CheckpointService.ts`).
  - Diffs run between checkpoint refs (`CheckpointDiffQuery.ts`, `Diffs.ts`) and can be patch or numstat, with whitespace ignored and path filters.
- **gh in WSL** has its own failure: [#23603](https://github.com/pingdotgg/t3code/issues/23603) reports "gh credential lookups leak a dbus-daemon per call on hosts without a session bus (WSL)".

## 7. Testing Windows and WSL

**T3 Code [src][doc].**
- `ci.yml` runs only on Ubuntu and macOS (Blacksmith runners).
- `.github/workflows/windows-tests.yml` is `workflow_dispatch` only, on `blacksmith-8vcpu-windows-2025`. Its header: "Manual only: nothing in the suite passes on Windows yet, so this exists to give contributors (and agents) a cloud Windows box to iterate against."
- **No workflow installs or runs WSL.**
- The WSL code has three test layers:
  - `layerTest` stubs for `DesktopWslEnvironment` and `DesktopWslServerTree`;
  - tests of the generated shell scripts (install, prune, stop), executed with real `sh` on Linux CI (#10301, #14351: "Keep WSL busy-runtime fixtures visible when sh is bash");
  - package-time validation of the embedded archive (`verify-windows-desktop-artifact.ts`).
- Real WSL behaviour is checked by hand. #11511 says: "Not run by me: an actual WSL launch. There is no Windows machine in reach; the next preview release exercises the Windows build… and a Windows tester needs to confirm the distro-side launch." #22478's live numbers came from "a disposable WSL2 distro" run by the author.

**What GitHub-hosted runners can do.**
- [doc] The `actions/runner-images` readme for Windows Server 2025 lists "Windows Subsystem for Linux (WSLv1): Enabled" and "Windows Subsystem for Linux (Default, WSLv2): 3.0.3.0". The Windows Server 2022 readme lists only WSLv1. Paths: `images/windows/Windows2025-Readme.md` l.11–12 and `Windows2022-Readme.md` l.11, at `c87f6f636f`.
- [src] `Vampire/setup-wsl` v7.2.0 defaults to `wsl-version: 2` and says "Currently, WSLv1 and WSLv2 are tested". Its `test.yaml` runs a matrix of `wsl-version: [1, 2]` on `windows-2022`, `windows-2025` and `windows-latest`. Each job asserts with `wsl.exe --list --verbose` that the distro "should be running on WSLv2". The latest `master` run, 40634392280 on 2026-10-28, concluded `success`. I could not list per-job results because the API returned 502.
- [issue] [actions/runner-images#11869](https://github.com/actions/runner-images/issues/11869): `wsl --install Ubuntu` works on GitHub's `windows-2025` but fails on Azure DevOps hosted agents. Those run on `Standard_DS2_v2`, which has no nested virtualization, and fail with `HCS_E_HYPERV_NOT_INSTALLED`. Maintainers said it depends on "the infrastructure being used by the runner image", not the image.
- **Conclusion [inference].** A GitHub-hosted `windows-2025` runner, with `Vampire/setup-wsl` or `wsl --install -d Ubuntu --no-launch`, can very likely run real WSL2 today. Loom can then exercise these in CI:
  - `wsl.exe` stdio relay, EOF and kill semantics;
  - bridge install;
  - the login-env probe;
  - process-group kill.

  GitHub does not document nested virtualization as a guarantee. Third-party Windows runners (Blacksmith, Depot, Azure DevOps) may not support it. Before relying on it, add a canary job that fails loudly when `wsl -l -v` reports VERSION 1. Networking modes (mirrored, NAT with a firewall) and Windows 10 cannot be covered this way.

## Comparison: OpenCode Desktop and VS Code Remote-WSL

- **OpenCode Desktop v2.1.4 [src]** (`packages/gui-extensions/src/wsl/remote-cli.ts`, `sidecar.ts`, `main.ts`):
  - It finds `~/.opencode/bin/opencode` in the distro and checks its `--version`.
  - If it is missing or the wrong version, it installs with `curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash -s -- --version <desktop version>`, or `--binary <path>` for a locally built CLI. Then it verifies the version.
  - So OpenCode Desktop **downloads** a single-binary CLI pinned to the desktop's version and runs `opencode serve` as a long-lived sidecar over TCP (see the prior note).
- **VS Code Remote-WSL [doc]** ([docs](https://code.visualstudio.com/docs/remote/wsl)):
  - "The extension will install VS Code Server inside WSL". When VS Code is opened from Windows, the download happens on the Windows side. When it is started from a WSL terminal, it uses `wget` inside the distro.
  - "All other communication between the server and the VS Code client is accomplished through an random local TCP port."
  - "No shell startup scripts run when the server starts". The optional `~/.vscode-server/server-env-setup` is sourced instead.
  - Alpine and other non-glibc distros can break native extensions.

All three put a version-pinned server inside the distro, and all three talk to it over TCP. **None uses stdio as the main channel.** Loom's stdio-multiplexed bridge would be the outlier. That choice is justified by T3's loopback and NAT-IP bugs (#13738, #9056, #26200), but there is no field-tested prior art for it [inference].

## Takeaways for the Loom bridge

1. **Ship a self-contained binary for the bridge, not a Node script.** T3's SEA archive still hit glibc and `libatomic` gaps (#14393).
   - Loom's bridge is small, with no native addons. A static or musl build (Go or Rust), or a Bun or Node SEA built against an old glibc, avoids most of this. Then check that `bridge --version` runs in the distro before marking the install ready.
2. **Install by embedding and copying, as T3 does with `wsl-runtime.tar.gz`, rather than downloading.** It works offline and the version always matches.
   - Copy into the distro's ext4 (`~/.loom/bridge/<sha256>/`), not `/mnt/c`.
   - Use `flock`, a sha256 check, a temp dir plus `mv -T`, a ready marker containing the binary hash, and prune everything except current and previous, skipping any in use.
   - The copy needs `wslpath`, and automount can be disabled (#8297). Streaming the binary over the `wsl.exe` stdin would avoid `/mnt/c` and `wslpath` entirely [inference].
3. **Lifetime.**
   - The bridge should exit on stdin EOF *and* on a `getppid()` change (T3's 2 s poll).
   - Stopping should send a "shutdown" message over the channel and wait. Never rely on killing `wsl.exe` (#22478).
   - Keep a ledger of agent PGIDs, with start times, on disk in the distro, and reap them on the next bridge start (T3's `OpenCodeServerLedger`).
4. **Kill by process group, TERM then 1 s then KILL.** Consider `systemd-run --user --scope` when systemd is present, to catch processes that call `setsid`.
5. **Pre-warm and budget.** Allow 30 s for a cold distro, use about 10 s probes, classify `wsl.exe` transport failures (`timeout | spawn | process`) as retryable, and treat missing tools as fatal with a remediation message.
6. **Detection.** Don't call `wsl.exe --list` just because `System32\wsl.exe` exists. On Windows 11 that triggers the install prompt (#21038). Gate it on the user enabling an Environment, or use a cheaper check first.
7. **Env.** Probe the full login env, not only PATH as T3 does. Forward `SSH_AUTH_SOCK`-like needs explicitly (#5740).
8. **MCP.** Serve it from the bridge inside the distro, and give ACP agents a stdio shim, as T3's `acp-mcp-bridge` does.
9. **CI.** Add a `windows-2025` job with real WSL2 through `Vampire/setup-wsl`, plus a version canary. Keep the shell scripts unit-tested on Linux, as T3 does.
