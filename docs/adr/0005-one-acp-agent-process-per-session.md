# Each Session drives its own `opencode acp` process

Each Session runs its own `opencode acp` process, driven over the Agent Client Protocol (ACP) behind Loom's own adapter interface. We considered sharing one `opencode serve` per Client, driven through OpenCode's HTTP API. That is lighter per Session and allows steering a run, but under WSL its API sits on TCP inside the distro and depends on fragile localhost forwarding. Loom's tools would also need an OpenCode plugin, and Loom would be tied to an API only OpenCode speaks. With ACP, everything runs over stdio, Loom's tools are an MCP server passed per Session, the approval policy is set per process, and other ACP agents can be added later through the same adapter. ACP stays the transport of one adapter, not Loom's interface, so ACP's gaps and each agent's quirks don't leak into the Session service.

The costs:
- about 400 MB per live Session, kept in check by stopping the process of an idle Waiting Session;
- usage arrives only at the end of a turn;
- Loom must store the session ids OpenCode generates;
- OpenCode 2.1.4's ACP bridge refuses a second prompt during a run, so a queued message can't be steered into the run, only sent after interrupting it.
