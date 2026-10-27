# Loom

A developer workspace for AI-assisted software development: a server that keeps projects, artifacts and memory, and clients where coding agents do the actual work on the developer's machine.

## Language

**Project**:
A codebase tracked by Loom, backed by exactly one git repository hosted on a forge. Any **Team** member can add one, and every member sees all of them. A Project is archived rather than deleted: it disappears from pickers, but its memory, **Artifacts** and usage history stay.
_Avoid_: Repo, workspace

**Session**:
A unit of work on a **Project**: one agent conversation bound to one branch and a working copy, either its own isolated one or the **Project**'s main checkout, optionally linked to an issue and a merge request. A Session is private to its user and lives only on the machine where it was created.
_Avoid_: Discussion, chat, thread

**Client**:
The desktop application on a developer's machine, where Sessions, codebases and agents live.

**Agent**:
The coding agent a **Session** runs on (Pi or OpenCode), installed on the developer's machine and signed in to their own model providers. Loom drives it with the user's own setup (skills, extensions, MCP servers) plus Loom's tools, but never configures its providers or holds its credentials.

**Server**:
The shared, team-wide service that persists **Projects**, **Artifacts** and memory; it never executes development work.

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

**Artifact**:
A durable document produced during development and stored on the server, of one kind: a spec (what to build), a task (one vertical slice of a spec, picked up by a later **Session**), or a code review report. Agents write and revise Artifacts themselves; Loom gives each kind no structure beyond its markdown.
_Avoid_: Ticket, issue (for a task Artifact: it is not tracked on the **Forge**)

**User memory**:
A user's personal preferences and working habits, reused across all their **Projects**. Private to that user.

**Project memory**:
Context, decisions, conventions and knowledge about one **Project**, reused by agents throughout its lifecycle. Shared by everyone on the team.

**Memory entry**:
One remembered fact in a **User memory** or **Project memory**: a short title and a full description, with its author and the **Session** that wrote it. Agents see every entry's title and read descriptions on demand.
_Avoid_: Note, memory (for a single entry)

**Team**:
The group of users sharing one **Server**; a Server hosts exactly one Team. Membership follows the **Forge** organizations or groups the Server is configured with: belonging to one makes you a member, leaving it removes you.

**Forge account**:
A user's account on one **Forge** instance (e.g. github.com, a self-managed GitLab). A user logs in with any of their Forge accounts and can link several; Loom acts on the Forge only with the access that account already has.
_Avoid_: Identity, login

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
- A **Session** has one branch and at most one linked issue and one **Merge request**
- A **Session** runs on exactly one agent (Pi or OpenCode), chosen when the Session is created; it cannot change afterwards
- A **Session** is in exactly one status: **Working**, **Waiting** or **Archived**
- A **Project** has one **Project memory**; a user has one **User memory**
- A user has one or more **Forge accounts**; a Forge account belongs to exactly one user
- An **Artifact** belongs to a **Project** and may originate from a **Session**; teammates see that Session's issue and **Merge request**, never its title
- Any **Team** member can edit or delete an **Artifact**; edits keep a revision history, deletion is permanent
- A **User memory** or **Project memory** is a list of **Memory entries**
- Agents read, create and update **Memory entries** themselves; only users delete them
- Agents create, read and update **Artifacts** themselves; only users delete them
- Any **Team** member can edit or delete a **Project memory** entry; a **User memory** is visible only to its user

## Flagged ambiguities

- "Discussion" was used for what is now **Session**; a Session is 1:1 with the agent's own conversation.
- "In progress" / "working" in the original brief: resolved as **Waiting** (needs attention, shown in the **Inbox**) vs **Working** (agent busy, collapsed).
