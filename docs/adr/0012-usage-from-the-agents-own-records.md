# Usage is counted from the agent's own records, step by step

Loom first counted tokens only from what the agent reports over ACP at the end of a prompt (`PromptResponse.usage`). With OpenCode 2.4.2 that misses four things (#274):

- **Subagents.** Its ACP bridge adds up only the session's own steps. Subagents' steps go elsewhere, and their `opencode/session/child_update` statuses carry no usage.
- **Runs the agent starts on its own,** as on a Subagent's result: there is no prompt, so there is no `PromptResponse`.
- **What the agent uses for itself,** such as the model call that names an OpenCode session.
- **Use outside Loom**, such as the user's own `opencode` TUI or scripts, which Loom never sees. This includes everything from before Loom started reading, which the Dashboard's ranges (up to 90 days) cover.

The agent keeps all of it in its own records, so Loom reads them. We considered three sources for OpenCode:

- **Its SQLite database**: rejected. It is internal and changes between versions: sessions have already moved from a `session` table to `session_v2`. Under WSL it lives inside the distro, and Electron's main process touches no Environment's files (ADR 0008).
- **`opencode stats`**: totals per model over a range, Loom's and the user's runs mixed. Telling them apart means subtracting two sources that disagree on day boundaries.
- **Its API**, chosen. Loom asks a private server through the bridge's `exec`, with `opencode api --standalone`, and never the user's shared background service, which the probe avoids too. It reads:
  - `session.list`: every session in every project, with its parent, folder, total usage and last change, newest change first;
  - `session.message.list --param type=assistant`: one message per step, with when it completed, its model, tokens and cost.

Each step is counted once, on the day it completed and under its model. Loom keeps, per agent, Environment and conversation, how far it has counted (the time and id of the last step counted) and whose it is (`agent_conversations`). Each reading lists the conversations changed since the last one, and reads only the steps after that point. A conversation's total beyond everything counted (OpenCode's title) is counted too, under its latest model. A forked conversation starts with copies of its parent's steps, under new ids: a step with the same completion time, model and usage as one already counted is that step (`usage_steps`). Reading again, or after a restart, counts nothing twice.

A conversation belongs to:
- a **Session**, if it is the Session's own conversation or one of its Subagents;
- **Session highlights**, if it is one of their checks, which Loom files before the check runs;
- the Session or checks the **conversation that started it** belongs to, followed up the chain, so a Subagent's Subagent counts too;
- **outside Loom** otherwise, kept per agent, Environment, folder, day and model (`outside_usage`), except in Loom's own folders (its worktrees, Session highlights' folder): what ran there was a Session's, possibly since deleted.

One filed as outside Loom is looked for again, as Loom may read it before it has saved that it is a Session's: once found, what it counted outside Loom moves to its owner.

**The past is counted too.** The first reading only notes where each conversation stands, so it is quick: a Session's first run waits for it, then counts from the records rather than ACP. Everything before that point is then counted in the background, step by step on its own day, and the Dashboard says so until it is done:
- **use outside Loom**: all of it, except what ran in Loom's own folders (its worktrees, Session highlights' folder), which were Loom's Sessions, possibly since deleted, already counted from their runs;
- **a Session's**: only what its runs didn't report (its Subagents, the runs its agent started on its own, its titles), as what its steps used by day and model beyond what Loom had recorded of them when it first read the records (`usage_baseline`);
- **Session highlights' checks'**: nothing, as their runs reported it all.

Loom reads the records when the Environment connects, after a run, a Subagent or a check ends, and when the Dashboard opens (`usage.read`). The Dashboard never waits for a reading: it shows what Loom has counted at once, and is worked out again each time a reading or the past's count adds anything (the `usage` topic), without reading again.

The Dashboard counts use outside Loom with the rest, in every figure but those only Loom knows (outcomes, Merge requests, Top Sessions). A conversation outside Loom that is no Subagent's, and ran in none of Loom's folders, is a Session started on the day the agent started it. Its runs count in the median run: a run is its steps from the prompt to the one that doesn't go on with the tools it called (OpenCode's `finish`), timed from the first step's start to the last one's completion; one going on when Loom reads is taken up at the next reading (`agent_conversations.run_started_at`, `outside_runs`). Each folder it ran in goes under a Project when it is the Project's checkout or a Session's working copy, or inside one, the deepest such folder winning, as of when the Dashboard is worked out: a Project linked later takes its past too. Any other folder shows as its own, for the five that used the most in the range, and the rest together as "Other folders".

Use outside Loom was first kept per agent, day and model, with no folder. On upgrading, each conversation outside Loom is counted again as its past, by folder: its steps up to where it had been counted, and all it had accounted for beyond them, with its first step. The steps counted before are marked (`usage_steps.recounted`), so the count again takes each once, whether or not it was counted before.

ACP is still the only way Loom drives a Session (ADR 0005). This is the agent's own CLI read through the bridge, as `opencode --version` is.

The design is agent agnostic. An agent adapter that keeps such records offers an `AgentUsageSource`: its conversations changed since a time (with parent, folder and, if it keeps one, total), and a conversation's steps completed since a time (with time, model, tokens and cost). Everything else is shared: the bookkeeping, the owners, the past, the outside bucket and the Dashboard. Claude Code or Codex would list theirs from their JSONL transcripts, read through the bridge. An agent with no source is counted from what its runs report over ACP, as before.

The costs:
- **An OpenCode that can't list its sessions** (one older than its `api` command) is counted from ACP as before: no Subagents, and nothing outside Loom.
- **A conversation whose steps can't be listed** is counted from its total, as of its last change, rather than step by step. This happens when a step is bigger than the 1 MB of output the bridge passes on, as one with a huge tool output can be; smaller pages are tried first.
- **A deleted Session's conversation in its Project's checkout** can't be told from the user's own runs there: its past counts as outside Loom as well as under the deleted Session. A worktree Session's can, and doesn't.
- **A Session from before Loom kept the agent's id** of an earlier conversation (one the agent refused to resume) counts that conversation as outside Loom.
- **Each reading starts private servers**, about 0.3 s each: one for the list, and one for each changed conversation. The first count of the past reads every conversation's steps, six conversations at a time, each a page at a time: 20 messages first, then as many as fit in about 512 KB from the size of those before, at most 200. It runs in the background and picks up where it left off after a restart.
- **A conversation outside Loom forked from a Session's**, counted again on upgrading, counts the steps it copied from the Session's as its own too.
- **The bookkeeping** is one small row for every conversation the agent ever had, the Sessions' usage as Loom first saw it, and a few rows a day for use outside Loom.
