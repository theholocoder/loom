# Driving agents and git inside WSL2 from the Windows Client

Research for [#36](https://github.com/theholocoder/loom/issues/36). The question: what does the **Environment** design from [#32](https://github.com/theholocoder/loom/issues/32) depend on? In that design the agent, `git`, `gh` and `glab` start inside a WSL distro through `wsl.exe -d <distro>`, while the Electron Client runs natively on Windows.

Researched 2026-10-27 on a Linux machine with no Windows or WSL, so **nothing here was run on Windows**. Each claim carries a trust tag:

- **[doc]**: documented by the owner (Microsoft Learn, Node.js docs, OpenCode docs).
- **[src]**: read in the owner's source code: `microsoft/WSL` at `master` (`e68fd7e`, 2026-10-27), or `anomalyco/opencode` at tag `v2.1.4`.
- **[issue]**: reported in a GitHub issue, not documented.
- **[inference]**: my reading of the sources above. Not confirmed.
- **[test]**: unknown. Needs a run on a real Windows machine.

## Summary

| Question | Answer | Confidence |
|---|---|---|
| stdio through `wsl.exe` | A raw byte relay with no CRLF translation, so NDJSON works. `wsl.exe`'s *own* messages are UTF-16LE unless `WSL_UTF8=1`. | src + issue; test the long-run behaviour |
| `opencode serve --stdio` | stdio carries only `{"url"}` and the lifetime. The API is HTTP on TCP inside the distro, reached through localhost forwarding. | src + doc |
| `opencode acp` | ACP is NDJSON on stdio, so it goes straight through the relay. It exits on stdin EOF. | src |
| Process lifetime | Killing `wsl.exe` closes the child's stdin and stdout but does **not** signal it. stdin-EOF-aware processes die; others are orphaned. | src (inference); test |
| Kill a tree | No Windows-side primitive. Kill inside the distro by process group (`setsid` + `kill -- -PGID`). | inference; test |
| Login-shell env | `wsl.exe -d D --exec /bin/sh -c 'exec "$SHELL" -ilc "env -0"'`. Windows env is **not** passed in, except `WSLENV`. | src + doc |
| Loom's tools | Use stdio. Run one long-lived Loom bridge in the distro over `wsl.exe` stdio. TCP from WSL to Windows depends on the networking mode and the firewall. | doc + inference |
| Performance | Distro FS: fast. `/mnt/c`: slow. `\\wsl.localhost` from Windows: about 26–73× slower. The per-call cost of `wsl.exe` is **not documented**. | doc + issue; test |
| Detection | `wsl.exe --version` (missing or failing means WSL is absent) and `wsl.exe -l -v` (UTF-16LE, `*` marks the default). | doc + src |
| `\\wsl.localhost` paths | Supported since build 21354, and `\\wsl$` still works. Editors may block UNC hosts. | doc; test Electron `shell.*` |

**Strong prior art:** OpenCode's own desktop app ships a WSL mode (`packages/gui-extensions/src/wsl/`). It already does most of what Loom needs, and is cited throughout.

## 1. stdio through `wsl.exe`

**How the relay works [src].** For WSL2, `wsl.exe` hands its stdin, stdout and stderr handles to the service. If a handle is a pipe rather than a console, it is relayed as a plain stream (`svccomm.cpp`: `LxssHandleInput` / `LxssHandleOutput`). Inside the VM, a per-process `Relay` copies bytes between hvsockets and the child's pipes (`src/linux/init/init.cpp`, around lines 1880–2200):
- No line or encoding translation. CRLF is not added on pipes.
- Writes to the child's stdin that would block are buffered (`PendingStdin`) to avoid deadlocks.
- A zero-byte read on the stdin socket closes the child's stdin, so **EOF propagates**.

A pseudo-terminal is used only when the handle is a console. Node's `spawn` with `stdio: 'pipe'` gives pipes, so the stream is byte-clean.

**Encoding [src][issue].** `wsl.exe` writes its *own* output in UTF-16LE (`--list`, `--status`, `--help` and error messages) unless the environment variable `WSL_UTF8=1` is set (`WslClient.cpp:1883`). Microsoft keeps UTF-16 for compatibility ([microsoft/WSL#13093](https://github.com/microsoft/WSL/issues/13093), where OneBlue says "`WSL_UTF8` is available for situations where you want wsl.exe to output UTF8"). The output of the *Linux program* is relayed raw, which is UTF-8 in practice. So Loom should:
- set `WSL_UTF8=1` on every `wsl.exe` spawn;
- still sniff UTF-16 when decoding `wsl.exe`'s own errors, as OpenCode's `detectOutputEncoding` does in `runtime.ts`.

**Large messages and truncation [issue].**
- The old reports of truncated pipelines ([#4082](https://github.com/microsoft/WSL/issues/4082), refiled as [#11111](https://github.com/microsoft/WSL/issues/11111)) were closed by a maintainer as a race in the Windows filesystem, not in the stdio relay.
- No open issue reports corruption of long-lived stdio JSON streams.
- Open reliability issues affect *session creation*, not established streams: relay and vsock leaks under heavy use of many short `wsl.exe -e` calls ([#41242](https://github.com/microsoft/WSL/issues/41242), [#40650](https://github.com/microsoft/WSL/issues/40650)), and a `wsl.exe` that spins at 100% CPU after interop EOF in long-lived interactive sessions ([#41173](https://github.com/microsoft/WSL/issues/41173)).

Relevant lesson: **prefer a few long-lived `wsl.exe` processes over many short ones.**

**`opencode serve --stdio` [src].**
- In `packages/cli/src/server-process.ts`, stdio mode prints `JSON.stringify({url})`, then blocks in `waitForStdinClose()`. It also deletes `OPENCODE_SERVER_PASSWORD` from its own environment so tools don't inherit it.
- So stdio carries only lifetime. The API (HTTP and SSE) runs on TCP *inside the distro*.
- From Windows, that port is reachable at `127.0.0.1:<port>` through WSL's localhost forwarding. This is on by default in NAT mode: "ports bound to wildcard or localhost in the WSL 2 VM should be connectable from the host via `localhost:port`" ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), `localhostForwarding`) [doc].
- In mirrored mode, `127.0.0.1` is shared both ways ([networking](https://learn.microsoft.com/en-us/windows/wsl/networking)) [doc].
- OpenCode Desktop's own WSL sidecar uses plain `serve --hostname 0.0.0.0 --port <port allocated on Windows>` and polls `http://127.0.0.1:<port>/api/info` from Windows (`sidecar.ts`).
  - It binds `0.0.0.0` rather than `127.0.0.1`, and picks the port on the Windows side. That suggests it found binding on loopback with `--port 0` less reliable, but no reason is recorded **[test]**.
  - It does *not* use `--stdio`, because it feeds a bootstrap script to `bash -se` over stdin and then closes stdin.

**`opencode acp` [src][doc].**
- ACP is JSON-RPC as NDJSON over stdio: `ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream())` in `packages/cli/src/commands/handlers/acp.ts`. The [OpenCode ACP docs](https://opencode.ai/docs/acp) say it "communicates with your editor over JSON-RPC via stdio".
- It starts its own private server as a child (`Standalone.start()`, which runs `serve --stdio --port 0`). That server lives entirely inside the distro, so **no TCP crosses the VM boundary**.
- When the connection closes (stdin EOF), it calls `process.exit`.
- The ACP SDK enforces a maximum message size (`MessageTooLargeError`), which has nothing to do with WSL.

**Verdict:** ACP through `wsl.exe` is the cleaner fit of the two: one byte stream, no ports, and EOF-driven lifetime. A soak test is still needed **[test]**: hours of streaming, MB-sized messages, and many concurrent `opencode acp` processes, each holding one `wsl.exe`.

## 2. Process lifetime

**What the source shows [src].** In the VM-side relay loop (`init.cpp`):
- When the control channel to `wsl.exe` closes, the relay `break`s out of its loop and shuts down all the sockets. "A zero-byte read means that the control channel has been closed and that the relay process should exit."
- The relay does **not** `kill` its child.

So when `wsl.exe` dies, whether it exits or is killed with `TerminateProcess`:
- the Linux child sees **stdin EOF**;
- its next write to stdout or stderr gets `EPIPE`/`SIGPIPE`;
- it is not signalled otherwise **[inference]**.

**Consequences.**
- `opencode serve --stdio`, `opencode acp` and Pi `--mode rpc` all exit on stdin EOF (per [#24](https://github.com/theholocoder/loom/issues/24) and the source above), so they die with Loom, even on a crash.
- **Grandchildren of the agent** do *not* get stdin EOF: shells, dev servers and test runners that the agent's tools started. Whether OpenCode or Pi kill their tool subprocesses on exit decides whether these leak **[test]**.
- On Linux, Node documents the same caveat: "child processes of child processes will not be terminated" ([child_process](https://nodejs.org/api/child_process.html#subprocesskillsignal)) [doc].

**Windows side [doc].** `subprocess.kill()` on Windows terminates *only `wsl.exe`*: every signal is forceful termination ([child_process](https://nodejs.org/api/child_process.html#subprocesskillsignal)). [#7300](https://github.com/microsoft/WSL/issues/7300) reports that Ctrl-C events delivered to a console `wsl.exe` arrive as `SIGHUP` [issue]. That only applies to console sessions, which Loom doesn't use.

**Killing a tree inside the distro [inference].**
1. Start each long-lived command in its own session and process group.
2. Have it report its PGID first.
3. Kill it with a second call: `wsl.exe -d D --exec kill -TERM -- -<pgid>`. Escalate to `-KILL`.

A wrapper such as `setsid sh -c 'echo $$; exec opencode acp'` gives the PGID on the first stdout line. Two blunter fallbacks exist:
- `wsl --terminate <distro>`, which kills *everything* in the distro, including the user's own shells [doc].
- `wsl --shutdown`, which kills every distro [doc].

Both are unusable for routine control. An in-distro bridge (§4) would make this a local `process.kill(-pgid)`.

**Distro idle shutdown [doc].**
- A distro shuts down after `instanceIdleTimeout` (default 15 s) with no processes, and the VM after `vmIdleTimeout` (default 60 s) ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
- A long-lived `wsl.exe` keeps the distro up. Cold starts after idle add latency.
- OpenCode guards every `wsl.exe` call with a 20 s timeout. Its reason: "When the distro or the LXSS service is wedged (Ubuntu first-run state, Windows update pending, etc.) wsl.exe produces no output and never exits" (`runtime.ts`) [src]. Loom should do the same.

## 3. Shell environment

**What `wsl.exe` runs [src]** (`WslClient.cpp` `ShellExecOptions`, `init.cpp` around lines 770–815):
- `wsl.exe -d D <cmd…>` (or `-- <cmd…>`): runs the user's passwd shell as `$SHELL -c "<cmd>"`. That is **non-login and non-interactive**, and the shell expands `$VAR` in the command line.
- `--shell-type login`: the same, with `argv[0]` set to `-<shell>`, so it is a login shell.
- `--exec`/`-e`: runs the program directly, with no shell. OpenCode always uses `--exec` for exactly this reason: "`--` hands the command line to the distro's default shell, which expands `$VAR`…" (`runtime.ts`).
- `--cd <dir>`: sets the working directory. A leading `/` means a Linux path, `~` means home. Documented in `wsl --help` (`Resources.resw`).

**Initial environment [src][doc].**
- `init` builds a fresh Linux environment: `HOME`, `USER`, `LOGNAME` and `SHELL` from passwd, plus WSL variables.
- `PATH` gets the Windows `PATH` appended unless `appendWindowsPath=false` ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
- **Windows environment variables are not inherited.** Only those listed in `WSLENV` cross, with the flags `/p`, `/l`, `/u` and `/w` ([filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv)).

**The equivalent of `$SHELL -ilc 'env -0'` [inference]:**

```
wsl.exe -d <distro> --exec /bin/sh -c 'exec "$SHELL" -ilc "env -0"'
```

- `SHELL` is set by `init` from passwd, so this picks the user's real login shell. Its NUL-separated output passes the relay untouched.
- The same probe is what OpenCode Desktop runs natively (`packages/desktop/src/main/service/shell-env.ts`). It tries `-il`, then `-l`, with a 5 s timeout, and skips nushell.
- In WSL its own sidecar instead runs `bash -se` with a script that does the following (`sidecar.ts`):
  - strips `/mnt/*` entries from `PATH`;
  - sets `WSLENV=` (empty);
  - disables OpenCode's file watcher.
- Without a TTY, `-i` may print job-control warnings on stderr. Ignore stderr **[test]**.

**Passing the resolved env to children.** The Windows env doesn't cross, so there are three options:
- (a) list each variable in `WSLENV` with `/u`;
- (b) wrap every command in `env -i K=V… cmd`, which exposes values in `/proc/<pid>/cmdline` to other users of the distro;
- (c) better, have an in-distro bridge (§4) resolve the env once and spawn the children itself.

For secrets such as `OPENCODE_SERVER_PASSWORD`, use `WSLENV=OPENCODE_SERVER_PASSWORD/u` or send them over stdin, never in argv.

**PATH hygiene.** Strip `/mnt/c/...` entries, as OpenCode does. Otherwise every PATH lookup that misses walks the slow Windows filesystem. One exception: VS Code's `code` launcher for Remote-WSL is found through the Windows PATH. So the editor command (#32) should run with the unstripped PATH, or Loom should resolve `code` before stripping.

## 4. How Loom's tools reach Electron's main process

[#7](https://github.com/theholocoder/loom/issues/7) puts Loom's tools in the main process, with thin agent-side shims over "a private local channel". In WSL the shim runs inside the VM. There are three options.

**TCP from WSL to Windows [doc].**
- In NAT mode, the default, Linux must target the Windows host IP (`ip route show | grep -i default | awk '{print $3}'`), not `127.0.0.1`.
- The listener must accept those non-loopback connections. Docs: "you may need to bind your application to `0.0.0.0`", which exposes it to the LAN.
- The Hyper-V firewall, on by default since WSL 2.0.9, filters this traffic ([networking](https://learn.microsoft.com/en-us/windows/wsl/networking)).
- In mirrored mode (Windows 11 22H2+, opt-in), Linux reaches Windows at `127.0.0.1`.

Loom can't assume either mode, so **this is fragile and should not be relied on.**

**TCP from Windows to WSL [doc].** Electron connects to a listener inside the distro on `127.0.0.1:<port>` through localhost forwarding (NAT default) or mirrored mode. This works by default, but `localhostForwarding` can be turned off by the user.

**stdio [inference]. Recommended.** Run one long-lived **Loom bridge process per Environment** inside the distro, started through `wsl.exe --exec`. Its stdio is a multiplexed JSON channel to Electron's main process, and it listens on a Unix socket in the distro, e.g. under `$XDG_RUNTIME_DIR` or `~/.loom/run`. Agent shims connect to that Unix socket:
- the Pi extension;
- the OpenCode plugin;
- or a stdio MCP server command passed in ACP `session/new` (see [#35](https://github.com/theholocoder/loom/issues/35)).

This works the same in NAT, mirrored and VPN setups, needs no firewall rule, and dies with Loom through stdin EOF. The same bridge can also:
- hold the resolved login env (§3);
- spawn and kill agents and git by process group (§2);
- run git without paying the `wsl.exe` cost per call (§5).

VS Code Remote-WSL uses the same shape: a server installed inside the distro, talking to the client over "a random local TCP port" ([VS Code WSL docs](https://code.visualstudio.com/docs/remote/wsl)) [doc]. OpenCode Desktop also runs one long-lived server per distro [src].

## 5. Performance

**Documented [doc].**
- "For the fastest performance speed, store your files in the WSL file system if you are working in a Linux command line" ([filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)).
- `/mnt/c` is the slow path. It is the long-standing [#4197](https://github.com/microsoft/WSL/issues/4197) (523 comments, open).
- This confirms #32's "allow `/mnt/c` with a warning".

**Windows to distro files [issue].** [#41480](https://github.com/microsoft/WSL/issues/41480), open, measures `\\wsl.localhost` (Plan 9) on a 3,000-file tree:
- about 26× native for a directory walk;
- about 73× native for reads.

It notes that "a Windows `git status` on a WSL repo issues tens of thousands" of round trips. So Loom must **never run Windows `git.exe` against a WSL checkout**, and must never read the checkout through UNC paths for diffs. Run git inside the distro.

**Cost of one `wsl.exe` call [test].**
- No Microsoft documentation or benchmark gives the per-call latency of `wsl.exe -d D --exec git status` on a warm distro, and none of the issues reviewed measured it.
- The fixed cost (process create, COM call to the service, hvsocket setup, relay fork) is likely in the tens of milliseconds, but **this must be measured** [inference].
- Cold starts are slower, and OpenCode budgets 20 s for them.
- Many short calls also hit the session-leak issues above ([#41242](https://github.com/microsoft/WSL/issues/41242): "agent-heavy workload — 5–15 concurrent sessions, frequent short `wsl.exe -e` calls").

**Recommendation.** Diff refreshes should run git through the long-lived bridge (§4), so there is no `wsl.exe` per call. The native cost of git inside ext4 is then the same as on Linux.

To measure on Windows:
- warm `wsl.exe --exec true` latency (p50/p95);
- `git status`, `git diff --stat` and `git worktree add` on a medium repo in three places: (a) through per-call `wsl.exe`, (b) through the bridge, (c) on `/mnt/c` through the bridge.

## 6. Detection

**WSL missing [src][inference].** OpenCode's `probeRuntime` runs `wsl --version` and treats a spawn error or a non-zero exit as "unavailable" (`runtime.ts`).
- `wsl.exe` exists in `System32` on all modern Windows, even without WSL installed. In that state it prints install guidance and exits non-zero, so check the exit code, not mere presence **[test]**.
- `--version` exists only on the Store/MSI WSL, not the old inbox one ([wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config): "If `wsl --version` is not recognized, you are likely using an older inbox version"). Treat a failing `--version` as "missing or too old", and offer `wsl --install` / `wsl --update`.
- Resolve `wsl.exe` from `%SystemRoot%\System32`, as OpenCode's `system32()` does. If Electron were 32-bit, `Sysnative` would apply ([basic-commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)), but Loom ships x64 only.

**Listing distros [doc][src].**
- `wsl.exe --list --verbose` (`-l -v`) prints NAME, STATE and VERSION. `*` marks the default.
- `--quiet` prints only names, and `--running` only running ones.
- The output is UTF-16LE when piped unless `WSL_UTF8=1` [src]. Decode it with BOM or zero-byte sniffing. OpenCode's parser: `/^\s*(\*)?\s*(.*?)\s{2,}\S+\s+(\d+)\s*$/`. The header row and column labels are **localized** ([#41937](https://github.com/microsoft/WSL/issues/41937) shows a Chinese UI), so parse by column shape, not by header text.
- Keep only VERSION 2 distros.
- `wsl --status` shows the default distro but is fully localized, so prefer the `*` in `-l -v`.
- A hung `wsl.exe` is a real failure mode ([#41937](https://github.com/microsoft/WSL/issues/41937) was closed as third-party security software truncating output). Always use a timeout.

**Per-Environment checks.** Run `wsl.exe -d D --exec /bin/true` to prove the distro can execute: OpenCode's `probeDistro`. It also catches distros stuck on a first-run prompt. Then run the login-env probe (§3), and the `git`/`gh`/`glab`/agent detection from #24 inside that env.

## 7. Paths

**[doc]**
- `\\wsl.localhost\<distro>\…` replaced `\\wsl\…` in Windows build 21354, "to avoid issues when there is a machine on the network named 'wsl'". `\\wsl$` continues to work ([WSL release notes](https://learn.microsoft.com/en-us/windows/wsl/release-notes), builds 21354 and 21364).
- Windows 11 has `\\wsl.localhost`. On Windows 10 it may depend on the WSL package version **[test]**; fall back to `\\wsl$`.
- Inside the distro, `wslpath -w <linux path>` gives the Windows form, so Loom doesn't need to build it by hand [inference].

**Opening files and folders.**
- `explorer.exe` accepts these paths: the docs tell users to type `\\wsl$` in the address bar [doc].
- Whether Electron's `shell.openPath` and `shell.showItemInFolder` work on `\\wsl.localhost` paths is not documented **[test]**.
- Windows-only editors may block UNC hosts. VS Code ≥ 1.78.1 requires the host to be in `security.allowedUNCHosts` or approved at startup ([VS Code on Windows](https://code.visualstudio.com/docs/setup/windows)) [doc].
- As #32 already decided, `code` should run *inside* the distro so it opens Remote-WSL.
- The distro must be running, or start on access, for UNC paths to resolve. Opening a path may wake a stopped distro **[test]**.

## Follow-ups that need a Windows machine

1. **Soak test:** `opencode acp` and `opencode serve --stdio` through `wsl.exe` for hours, with MB-sized messages and 10+ concurrent processes. Check for data loss, stalls and `wsl.exe` CPU use.
2. **Lifetime:** kill Electron with Task Manager, then check inside the distro for leftover `opencode`/`pi` processes and their tool grandchildren. Verify the `setsid` + `kill -- -PGID` recipe.
3. **Latency:** warm and cold `wsl.exe --exec true` and `git status`, per call vs through a bridge, on ext4 vs `/mnt/c`.
4. **Networking:** `serve --stdio --hostname 127.0.0.1 --port 0` reached from Windows in NAT and mirrored modes, and with `localhostForwarding=false`. Why OpenCode binds `0.0.0.0`.
5. **Detection:** what `wsl.exe --version` and `-l -v` print and return with WSL missing, inbox-only, no distro, and a distro on its first-run prompt, in a non-English locale.
6. **Paths:** Electron `shell.openPath` and `showItemInFolder` on `\\wsl.localhost` paths, with the distro stopped and running, on Windows 10 and 11.

## Sources

- Microsoft Learn: [Basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands), [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems), [Networking](https://learn.microsoft.com/en-us/windows/wsl/networking), [Advanced settings (wsl.conf / .wslconfig)](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), [Release notes](https://learn.microsoft.com/en-us/windows/wsl/release-notes).
- microsoft/WSL source (`master` `e68fd7e`): `src/windows/common/WslClient.cpp` (`ShellExecOptions`, `WSL_UTF8`), `src/windows/common/svccomm.cpp` (stdio handle types), `src/linux/init/init.cpp` (shell launch, stdio relay, control channel), `localization/strings/en-US/Resources.resw` (`wsl --help`).
- microsoft/WSL issues: [#4082](https://github.com/microsoft/WSL/issues/4082), [#4197](https://github.com/microsoft/WSL/issues/4197), [#7300](https://github.com/microsoft/WSL/issues/7300), [#11111](https://github.com/microsoft/WSL/issues/11111), [#13093](https://github.com/microsoft/WSL/issues/13093), [#40650](https://github.com/microsoft/WSL/issues/40650), [#41173](https://github.com/microsoft/WSL/issues/41173), [#41242](https://github.com/microsoft/WSL/issues/41242), [#41480](https://github.com/microsoft/WSL/issues/41480), [#41937](https://github.com/microsoft/WSL/issues/41937).
- Node.js: [child_process](https://nodejs.org/api/child_process.html) (`kill()` on Windows, `windowsHide`, `detached`).
- VS Code: [Developing in WSL](https://code.visualstudio.com/docs/remote/wsl), [VS Code on Windows (UNC hosts)](https://code.visualstudio.com/docs/setup/windows).
- OpenCode `v2.1.4` source: `packages/cli/src/server-process.ts`, `packages/cli/src/commands/handlers/acp.ts`, `packages/gui-extensions/src/wsl/{runtime,sidecar,remote-cli}.ts`, `packages/desktop/src/main/service/shell-env.ts`; [ACP docs](https://opencode.ai/docs/acp).
