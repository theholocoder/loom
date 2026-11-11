# Loom

A local desktop workspace for AI-assisted software development: coding agents do the work on the developer's machine, and Loom keeps everything there, with no server or account of its own.

## Language

**Project**:
A git checkout the user has added to Loom on their machine, either an existing folder or a fresh clone. It belongs to that machine only. **Forge** features (starting a **Session** from an issue, **Merge requests**, **Babysit**) are available only when its remote is on a Forge the user is signed in to with that Forge's CLI.
_Avoid_: Repo, workspace, delete (a Project is **Removed**, never deleted)

**Removed** (Project):
A **Project** the user took out of Loom: hidden everywhere but the history, its **Sessions** all **Archived** and kept read-only (they can't be reopened), its usage kept. Its checkout folder stays on disk. Adding a checkout of it again offers to restore it, with its Sessions and settings. Loom recognises it by its *identity*: the host and repository of its `origin`, or else its **Environment** and path. Two Projects in use may share an identity.

**Session**:
A unit of work on a **Project**: one agent conversation in a working copy, either a git worktree of the **Project**'s checkout (a *worktree Session*: a new one Loom makes, or one that already exists) or the **Project**'s checkout itself (a *checkout Session*), optionally linked to an issue and a merge request. The Session's branch is whatever its working copy has checked out at the moment; it may change during the Session. Several checkout Sessions may share the checkout, and several worktree Sessions one worktree: archiving or deleting one of them leaves a shared worktree to the others, and only the last one removes it. A Session is private to its user and lives only on the machine where it was created.
_Avoid_: Discussion, chat, thread

**Client**:
The desktop application on a developer's machine, where Sessions, codebases and agents live. It is all of Loom: there is no server.

**Environment**:
Where a **Project** checkout's development work runs on a **Client** machine: the machine's native OS, or one WSL distro on Windows. The agent, git and the **Forge** CLIs of that checkout's **Sessions** all run inside it.
_Avoid_: Host, runtime, target

**Agent**:
The coding agent a **Session** runs on (OpenCode in v1), installed on the developer's machine and signed in to their own model providers. Loom drives it with the user's own setup (skills, extensions, MCP servers), but never configures its providers or holds its credentials.

**Effort**:
How much reasoning the agent's model puts into each prompt, at one of the levels the **Agent** offers for that model (`default` among them; some models have none). Picked with the model, as `provider/model`, for a **Session**: both change only between runs, from the next prompt.
_Avoid_: Thought level, variant, reasoning effort

**Working** (Session status):
The agent is currently running; the **Session** does not need the user's attention.

**Waiting** (Session status):
The agent has finished, was stopped or interrupted, hit an error, is stuck, has asked a question, is held on an **Approval request**, its **Merge request** has new feedback from **Babysit**, or was merged or closed while its worktree has uncommitted changes or unpushed commits; the **Session** needs the user's attention.

**Queued message**:
A message the user, or **Babysit**'s auto-prompt, sent a **Working** Session, waiting in the Session's queue to be sent to the agent once the runs before it settle. The user can remove it, or send it now: interrupt the run and send it. **Stop** interrupts the run and keeps the queue. "The queue" always means a Session's queued messages, never the **Inbox**.

**Attachment**:
A file or image the user sends with a message. Loom keeps it with the **Session**'s history on the **Client** machine, and writes a copy into the **Environment** for the agent to read with that message.
_Avoid_: Upload

**Approval request**:
The agent paused before an action that reaches beyond its **Session**'s own branch and working copy, until the user approves or denies it. A guardrail against mistakes, not a security boundary.
_Avoid_: Permission prompt, confirmation

**Archived** (Session status):
The **Session** is closed and kept for history. A new message reopens it (a worktree Session gets a worktree again, on the branch archiving kept), unless its **Project** was **Removed**: then it is read-only.

**Deleted** (Session):
A **Session** the user did away with for good, whatever its status: its agent stopped, its worktree removed as **Archive** does (its local branch kept, unsaved work held back until the user discards it), then its conversation, queue and **Attachments** gone. Only its usage stays, still counted on the dashboard. A checkout Session's checkout is left as it is. It can't be undone; **Archive** is the way to close a Session and keep it.
_Avoid_: Remove (a **Project** is Removed)

**Inbox**:
The Client's list of a user's **Waiting** Sessions, grouped by **Project**: what needs the user's attention now. A Session leaves the Inbox when the user replies (it becomes **Working**), archives it, deletes it or **Snoozes** it.
_Avoid_: Queue, notifications

**Snoozed**:
A **Waiting** Session the user set aside until a time they picked: out of the **Inbox** until then, when it comes back unread. Anything that changes its status (a reply, new feedback, archiving) ends the snooze early, as does waking it by hand. It is still **Waiting**: a snooze is not a status.
_Avoid_: Muted, deferred

**Forge**:
The service hosting a **Project**'s repository, issues and merge requests (GitHub or GitLab).

**Merge request**:
A request to merge a **Session**'s branch, whatever the **Forge** calls it (MR on GitLab, PR on GitHub).
_Avoid_: PR (except when talking about GitHub specifically)

**Babysit**:
Loom watching a **Session**'s open **Merge request** on the **Forge**: new feedback (review comments from others, failed checks, merge conflicts) puts the Session in **Waiting**, or is sent straight to the agent when auto-prompt is on (at most 3 times in a row without a message from the user, then it pauses and the Session goes **Waiting**); a merged or closed Merge request archives the Session, once its run has ended, unless its worktree has unsaved work (the Session goes **Waiting** instead); one closed without merging is left unread. The user can stop and restart the watch per **Session**; a newly linked Merge request is always watched.
_Avoid_: Watch, monitor

**Dock**:
The area under an open **Session**'s conversation, holding applets. The only applet so far is the **Terminal**. Whether a Session's Dock is open, and its height, belong to that Session, while Loom runs.
_Avoid_: Panel, bottom bar

**Terminal**:
A shell in Loom's **Dock**, run by the **Session**'s **Environment** in its working copy. A Session can have several. They keep running when another Session is shown, and end when closed, when their shell exits, when the Session is archived or when Loom quits. None outlives Loom. "Open in terminal" is different: it opens the working copy in the user's own terminal app.
_Avoid_: Console, shell (for the Dock's tab)

## Relationships

- A **Project** has many **Sessions**; a **Session** belongs to exactly one **Project**
- A **Project** checkout on a **Client** machine runs in exactly one **Environment**; its **Sessions** run there too
- A **Session** is on one branch at a time and has at most one linked issue and one **Merge request**: its current branch's, found after each turn, or one the user or the agent linked by hand for an edge case (a differently named source branch), which stays linked while the branch does
- A **Session** runs on exactly one agent, chosen when the Session is created; it cannot change afterwards
- A **Session** is in exactly one status: **Working**, **Waiting** or **Archived**; only a **Waiting** one can be **Snoozed**
- A **Removed** Project's Sessions are all **Archived**, and stay its Sessions

## Flagged ambiguities

- "Discussion" was used for what is now **Session**; a Session is 1:1 with the agent's own conversation.
- "Server", "Team", "Artifact" and Loom's own memory were dropped (ADR 0006): team knowledge, if any, reaches agents through the user's own MCP servers.
- "In progress" / "working" in the original brief: resolved as **Waiting** (needs attention, shown in the **Inbox**) vs **Working** (agent busy, collapsed).
