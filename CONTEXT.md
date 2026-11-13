# Loom

A local desktop workspace for AI-assisted software development: coding agents do the work on the developer's machine, and Loom keeps everything there, with no server or account of its own.

## Language

**Project**:
A git checkout the user has added to Loom on their machine, either an existing folder or a fresh clone. It belongs to that machine only. The user can rename it, and pick its colour (the same wherever it shows), its avatar and its default model (what its new **Sessions** start on). **Forge** features (starting a **Session** from an issue, **Merge requests**, **Babysit**) are available only when its remote is on a Forge the user is signed in to with that Forge's CLI.
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
How much reasoning the agent's model puts into each prompt, at one of the levels the **Agent** offers for that model (`default` among them; some models have none). Picked with the model (shown by the name its provider gives it, `provider/model` in its tooltip) for a **Session**: both change only between runs, from the next prompt.
_Avoid_: Thought level, variant, reasoning effort

**Working** (Session status):
The agent is currently running; the **Session** does not need the user's attention.

**Waiting** (Session status):
The agent has finished, was stopped or interrupted, hit an error, is stuck, has asked a question, is held on an **Approval request**, its **Merge request** has new feedback from **Babysit**, or was merged or closed while its worktree has uncommitted changes or unpushed commits; the **Session** needs the user's attention.

**Queued message**:
A message the user, or **Babysit**'s auto-prompt, sent a **Working** Session, waiting in the Session's queue to be sent to the agent once the runs before it settle. The user can edit its text, remove it, or send it now: interrupt the run and send it. **Stop** interrupts the run and keeps the queue; so does **Archive**, for when the Session reopens. "The queue" always means a Session's queued messages, never the **Inbox**.

**Attachment**:
A file or image the user sends with a message. Loom keeps it with the **Session**'s history on the **Client** machine, and writes a copy into the **Environment** for the agent to read with that message.
_Avoid_: Upload

**Approval request**:
The agent paused before an action that reaches beyond its **Session**'s own branch and working copy, until the user approves or denies it. A guardrail against mistakes, not a security boundary. Only the agent's actions ask: one the user starts in Loom themselves, such as squashing and merging the **Merge request** from its **Panel**, is confirmed in its own dialog instead.
_Avoid_: Permission prompt, confirmation

**Approval mode**:
How a **Session** handles its agent's **Approval requests**, picked when it starts and kept for good: _Supervised_ asks the user what the approval settings don't allow; _Full access_ approves every request, a push to the default branch included. Settings picks which one new Sessions start in.
_Avoid_: Authorization mode, permission mode, yolo

**Archived** (Session status):
The **Session** is closed and kept for history, its queue with it. A new message or Reopen reopens it (a worktree Session gets a worktree again, on the branch archiving kept), unless its **Project** was **Removed**: then it is read-only. A worktree's unsaved work holds archiving back until the user discards it or keeps it as a WIP commit on the branch.

**Deleted** (Session):
A **Session** the user did away with for good, whatever its status: its agent stopped, its worktree removed as **Archive** does (its local branch kept, unsaved work held back until the user discards it or keeps it as a WIP commit), then its conversation, queue and **Attachments** gone. Only its usage stays, still counted on the dashboard. A checkout Session's checkout is left as it is. It can't be undone; **Archive** is the way to close a Session and keep it.
_Avoid_: Remove (a **Project** is Removed)

**Inbox**:
The Client's list of a user's **Waiting** Sessions, grouped by **Project**: what needs the user's attention now. A Session leaves the Inbox when the user replies (it becomes **Working**), archives it, deletes it or **Snoozes** it.
_Avoid_: Queue, notifications

**Notification**:
A desktop notification that a **Session** went **Waiting**: its run finished or failed, its agent asked a question or for an **Approval request**, **Babysit** brought news of its **Merge request**, or it got stuck. Each kind is turned on in Settings (all are off until then); none comes while the window has the focus on that Session, nor for what the user did themselves (Stop, reopening). A click opens the Session.
_Avoid_: Alert, Inbox (the Inbox is the list, not the notification)

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

**Panel**:
One tool shown in a tab beside an open **Session**'s conversation: Changes, the **Merge request**, the issue, **Highlights**, a **Terminal**. Each kind has its own size, wherever it sits, and every Terminal shares one.
_Avoid_: Applet, widget, view, tab (the tab is only its handle)

**Panel area**:
A place an open **Session**'s **Panels** sit, as tabs. There are two: the **Side area** and the **Dock**. A Panel can be moved, or its tab dragged, from one to the other. Either can be split into two **Panel stacks**.

**Panel stack**:
One row of tabs in a **Panel area**, one Panel shown at a time. An area has one, or two once split: the **Side area**'s one above the other, the **Dock**'s side by side. The second takes the size of the Panel it shows along the area. A stack left with no Panel goes, and its area is one again.
_Avoid_: Pane, group, split (the act, not the thing)

**Side area**:
The **Panel area** to the right of the conversation, running from the **Glance strip** to the bottom. In a narrow window it slides over the conversation instead of sitting beside it.
_Avoid_: Sidebar, right panel, right area

**Dock**:
The **Panel area** under an open **Session**'s conversation and composer. **Terminals** open here, until moved to the **Side area**.
_Avoid_: Bottom bar, bottom area

**Layout**:
Which kind of **Panel** sits in which **Panel area** and **Panel stack**, and each kind's size. One for the whole app, kept when Loom quits. Which Panels are open, which one is shown and whether each Panel area is shown belong to each **Session**.

**Glance strip**:
The row under an open **Session**'s header showing what is changing right now (its **Merge request** and checks, its changes, the context used, its issue), each opening its detail.
_Avoid_: Status bar, Session info

**Session details**:
What rarely changes about a **Session** (its **Project**, **Environment**, working copy, branch, agent and model), shown on demand rather than kept on screen.
_Avoid_: Session info

**Review mode**:
A **Panel** with a large work surface (Changes, the **Merge request**'s diff) taking the main area of the **Session**, the conversation narrowed beside it, until the user leaves it. The **Side area** is hidden meanwhile.
_Avoid_: Fullscreen, zen mode

**Highlight**:
Something the user should know about a **Session**'s work, which **Session highlights** noted after a turn: something left for them to do, something not done, a risk, an assumption or a decision. Never rewritten: only resolved (by the model, saying why, or by the user) or reopened. A record, not an alert: a new one doesn't make the Session **Waiting**. They are shown in the Session's **Highlights** **Panel**.
_Avoid_: Note (a review comment on a diff line), summary, notification

**Session highlights**:
The setting that has a model of the user's picking, usually a cheap one, check each turn of every **Session** for **Highlights**, as a conversation of its own with every tool refused. Off until turned on with a model. Its usage counts on the dashboard under its model, but isn't the Session's own.

**Terminal**:
A shell in a **Panel**, run by the **Session**'s **Environment** in its working copy. A Session can have several. They keep running when another Session is shown, and end when closed, when their shell exits, when the Session is archived or when Loom quits. None outlives Loom. "Open in terminal" is different: it opens the working copy in the user's own terminal app.
_Avoid_: Console, shell (for the Panel's tab)

**Keybindings**:
The user's keyboard shortcuts, set in Settings: Loom's own until remapped, each action's shortcut changed or taken off, and the single-key ones (`j k r d u e`, and any shortcut without Ctrl) turned off at once. A shortcut given to one action is taken from any other that had it. The palette and the Ctrl+? list show the user's. The composer's Enter and Shift+Enter, and Ctrl+1…9, are fixed.
_Avoid_: Hotkeys, key map

**Regional format**:
How Loom writes dates and times: the order of the day, month and year and the clock (12-hour or 24-hour), the system's until picked in Settings, where the clock can be picked apart from it. The words ("Tomorrow", "3 h ago", month and weekday names) stay in the UI's language, English, whatever the format.
_Avoid_: Locale (for the setting), date language

## Relationships

- A **Project** has many **Sessions**; a **Session** belongs to exactly one **Project**
- A **Project** checkout on a **Client** machine runs in exactly one **Environment**; its **Sessions** run there too
- A **Session** is on one branch at a time and has at most one linked issue, which the user or the agent links, and one **Merge request**: its current branch's, found after each turn, or one the user or the agent linked by hand for an edge case (a differently named source branch), which stays linked while the branch does
- A **Session** runs on exactly one agent, chosen when the Session is created; it cannot change afterwards
- A **Session** is in exactly one status: **Working**, **Waiting** or **Archived**; only a **Waiting** one can be **Snoozed**
- A **Removed** Project's Sessions are all **Archived**, and stay its Sessions

## Flagged ambiguities

- "Discussion" was used for what is now **Session**; a Session is 1:1 with the agent's own conversation.
- "Server", "Team", "Artifact" and Loom's own memory were dropped (ADR 0006): team knowledge, if any, reaches agents through the user's own MCP servers.
- "Sidebar" and "Session info" were the right-hand area and its first tab before the **Panel** model (ADR 0009): the area is now the **Side area**, and Session info is split between the **Glance strip** and **Session details**.
- "In progress" / "working" in the original brief: resolved as **Waiting** (needs attention, shown in the **Inbox**) vs **Working** (agent busy, collapsed).
