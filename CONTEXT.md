# Loom

A local desktop workspace for AI-assisted software development: coding agents do the work on the developer's machine, and Loom keeps everything there, with no server or account of its own.

## Language

**Project**:
A git checkout the user has added to Loom on their machine, either an existing folder or a fresh clone. It belongs to that machine only. **Forge** features (starting a **Session** from an issue, **Merge requests**, **Babysit**) are available only when its remote is on a Forge the user is signed in to with that Forge's CLI.
_Avoid_: Repo, workspace

**Session**:
A unit of work on a **Project**: one agent conversation bound to one branch and a working copy, either its own isolated one or the **Project**'s main checkout, optionally linked to an issue and a merge request. A Session is private to its user and lives only on the machine where it was created.
_Avoid_: Discussion, chat, thread

**Client**:
The desktop application on a developer's machine, where Sessions, codebases and agents live. It is all of Loom: there is no server.

**Environment**:
Where a **Project** checkout's development work runs on a **Client** machine: the machine's native OS, or one WSL distro on Windows. The agent, git and the **Forge** CLIs of that checkout's **Sessions** all run inside it.
_Avoid_: Host, runtime, target

**Agent**:
The coding agent a **Session** runs on (OpenCode in v1), installed on the developer's machine and signed in to their own model providers. Loom drives it with the user's own setup (skills, extensions, MCP servers), but never configures its providers or holds its credentials.

**Working** (Session status):
The agent is currently running; the **Session** does not need the user's attention.

**Waiting** (Session status):
The agent has finished, was stopped or interrupted, hit an error, is stuck, has asked a question, is held on an **Approval request**, or its **Merge request** has new feedback from **Babysit**; the **Session** needs the user's attention.

**Approval request**:
The agent paused before an action that reaches beyond its **Session**'s own branch and working copy, until the user approves or denies it. A guardrail against mistakes, not a security boundary.
_Avoid_: Permission prompt, confirmation

**Archived** (Session status):
The **Session** is closed and kept only for history.

**Inbox**:
The Client's list of a user's **Waiting** Sessions, grouped by **Project**: what needs the user's attention now. A Session leaves the Inbox when the user replies (it becomes **Working**) or archives it.
_Avoid_: Queue, notifications

**Forge**:
The service hosting a **Project**'s repository, issues and merge requests (GitHub or GitLab).

**Merge request**:
A request to merge a **Session**'s branch, whatever the **Forge** calls it (MR on GitLab, PR on GitHub).
_Avoid_: PR (except when talking about GitHub specifically)

**Babysit**:
Loom watching a **Session**'s open **Merge request** on the **Forge**: new feedback (review comments from others, failed checks, merge conflicts) puts the Session in **Waiting**, or is sent straight to the agent when auto-prompt is on; a merged or closed Merge request archives the Session.
_Avoid_: Watch, monitor

## Relationships

- A **Project** has many **Sessions**; a **Session** belongs to exactly one **Project**
- A **Project** checkout on a **Client** machine runs in exactly one **Environment**; its **Sessions** run there too
- A **Session** has one branch and at most one linked issue and one **Merge request**
- A **Session** runs on exactly one agent, chosen when the Session is created; it cannot change afterwards
- A **Session** is in exactly one status: **Working**, **Waiting** or **Archived**

## Flagged ambiguities

- "Discussion" was used for what is now **Session**; a Session is 1:1 with the agent's own conversation.
- "Server", "Team", "Artifact" and Loom's own memory were dropped (ADR 0006): team knowledge, if any, reaches agents through the user's own MCP servers.
- "In progress" / "working" in the original brief: resolved as **Waiting** (needs attention, shown in the **Inbox**) vs **Working** (agent busy, collapsed).
