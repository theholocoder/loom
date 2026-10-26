# Every Environment is driven through a Loom bridge

Electron's main process never runs an Environment's commands or touches its files directly. Each Environment has one long-lived `loom-bridge` process, a small static Go binary shipped with the Client, and main talks to it over its stdio. On Linux and native Windows the bridge is a plain child process; in a WSL Environment it is started with `wsl.exe -d <distro> --exec`. The bridge resolves the user's shell environment, spawns the agent, `git`, `gh` and `glab`, multiplexes the agent's ACP stdio, kills process groups, and does every file operation main needs (diffs, attachments, worktrees, `.worktreeinclude` copies).

Most desktop tools (VS Code, Zed, JetBrains) use a helper like this only for an out-of-reach project (WSL, SSH, containers) and run local work in-process. We considered that, and also making a separate `wsl.exe` call for every WSL command. We run the bridge everywhere because then the Linux path we test every day is the same code WSL uses: only the launch line differs. It also gives every platform the same cleanup: when its stdin closes, because Loom quit or crashed, the bridge kills every process group it started, the agents' tool processes included. Making a separate `wsl.exe` call per command was rejected because many short `wsl.exe` calls are the pattern behind WSL's open leak and hang reports, killing a process needs a second call, and the shell environment would have to travel in argv.

## Consequences

- A second language (Go) in the repo, built for linux-x64 and windows-x64 in v1.
- In WSL the binary is streamed over stdin into `~/.local/share/loom/bridge/<version>/`, checked by SHA-256, older versions pruned. It holds no state; worktrees and the bridge binary are all Loom keeps in a distro.
- The bridge's version is the Client's; its handshake reports protocol version, OS and architecture, and a mismatch reinstalls it.
- A crashed bridge takes down every Session of its Environment at once; they go to Waiting (error) and resume on the next prompt.
- The protocol assumes only a byte stream, and how a disconnect is handled is a launch option (v1: kill everything). So a future remote Environment can be `ssh host loom-bridge`, with a bridge that survives disconnects.
