# Loom

A developer workspace for AI-assisted software development: a server that keeps projects, artifacts and memory, and clients where coding agents do the actual work on the developer's machine.

## Language

**Project**:
A codebase tracked by Loom, backed by a git repository hosted on a forge.
_Avoid_: Repo, workspace

**Session**:
A unit of work on a **Project**: one agent conversation bound to one branch and its isolated working copy, optionally linked to an issue and a merge request. A Session is private to its user and lives only on the machine where it was created.
_Avoid_: Discussion, chat, thread

**Client**:
The desktop application on a developer's machine, where Sessions, codebases and agents live.

**Server**:
The shared, team-wide service that persists **Projects**, **Artifacts** and memory; it never executes development work.

**Working** (Session status):
The agent is currently running; the **Session** does not need the user's attention.

**Waiting** (Session status):
The agent has finished, is stuck, or has asked a question; the **Session** needs the user's attention.

**Archived** (Session status):
The **Session** is closed and kept only for history.

**Inbox**:
The Client's list of a user's **Waiting** Sessions, grouped by **Project**: what needs the user's attention now. A Session leaves the Inbox when the user replies (it becomes **Working**) or archives it.
_Avoid_: Queue, notifications

**Artifact**:
A durable document produced during development (specification, implementation plan, code review, development note), stored on the server.

**User memory**:
A user's personal preferences and working habits, reused across all their **Projects**. Private to that user.

**Project memory**:
Context, decisions, conventions and knowledge about one **Project**, reused by agents throughout its lifecycle. Shared by everyone on the team.

**Team**:
The group of users sharing one **Server**; a Server hosts exactly one Team.

**Forge**:
The service hosting a **Project**'s repository, issues and merge requests (GitHub or GitLab).

**Merge request**:
A request to merge a **Session**'s branch, whatever the **Forge** calls it (MR on GitLab, PR on GitHub).
_Avoid_: PR (except when talking about GitHub specifically)

## Relationships

- A **Project** has many **Sessions**; a **Session** belongs to exactly one **Project**
- A **Session** has one branch and at most one linked issue and one **Merge request**
- A **Session** runs on exactly one agent (Pi or OpenCode), chosen when the Session is created; it cannot change afterwards
- A **Session** is in exactly one status: **Working**, **Waiting** or **Archived**
- A **Project** has one **Project memory**; a user has one **User memory**
- An **Artifact** belongs to a **Project** and may originate from a **Session**
- Agents read and write memory themselves; users can edit or delete memory entries

## Flagged ambiguities

- "Discussion" was used for what is now **Session**; a Session is 1:1 with the agent's own conversation.
- "In progress" / "working" in the original brief: resolved as **Waiting** (needs attention, shown in the **Inbox**) vs **Working** (agent busy, collapsed).
