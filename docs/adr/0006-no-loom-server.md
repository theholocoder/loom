# No Loom Server: Loom is a local-only Client

Loom is a single desktop Client with no server, account or login of its own. Projects, Sessions, settings and usage stay on the developer's machine, and the usage dashboard covers only that user on that machine. Loom has no memory or Artifacts of its own and gives agents no tools of its own in v1. Team knowledge such as specs, conventions and shared memory is outside Loom: a team that wants it provides an MCP server, and each developer adds it to their own agent setup, which Loom already loads.

We first designed a team-shared Server holding Projects, Project and User memory, Artifacts and team usage, with Forge OAuth for identity and Team membership. That tied Loom to OAuth apps on every Forge, to blocking Client/Server version checks, and to a service someone has to host, back up and migrate. It also stopped a developer from using Loom outside the company running that Server. The parts that really mattered to a team, knowledge and specs, are specific to each company and are better supplied over MCP than built into Loom.

## Consequences

- Any git checkout can be a Project; Forge features need its remote on GitHub or GitLab and the user's `gh`/`glab` login (ADR 0002).
- No Client/Server version coupling: the Client only updates itself.
- Nothing is shared between teammates or synced between one user's machines through Loom.
- Bringing back a team store later would be a new subsystem plus an account model, not a toggle.

## Amendment: one Loom tool (#66)

Loom gives each Session's agent one tool of its own after all: `link_merge_request`, from Loom's MCP server, which the bridge binary serves when run as `loom-bridge mcp` and which Loom passes in ACP's `session/new`. It holds no knowledge and calls nothing: Loom sees the agent call it and links the Merge request it names, as a manual link does. Team knowledge still comes only from the user's own MCP servers.

A second one joined it (#200): `link_issue`, which links the issue it names to the Session the same way, in place of any it had.
