# Session highlights run as a second agent conversation with every tool refused

**Session highlights** has a model read each turn of a Session and note the **Highlights**: what the user should know about the work (something left for them, something not done, a risk, an assumption, a decision). Loom has no model provider of its own and never holds the user's credentials (ADR 0003), so the model has to be reached through the user's agent. We considered three ways:

- **The Session's own agent**, asked after each turn. It is already running, but it would use the Session's model rather than a cheap one, and every check would fill the Session's context.
- **A one-off command** such as `opencode run -m <model>`. It is light, but it goes around the ACP adapter, ties Loom to OpenCode's CLI, and reports permissions and usage less well.
- **A second agent conversation**, chosen. This amends ADR 0005's "one `opencode acp` process per Session": while a check runs, its Session has a second one. After each turn, Loom starts its own `opencode acp` in the Session's Environment, through the same adapter (ADR 0005), with the model picked in the setting. Every tool is refused (OpenCode's `permission` is `{"*": "deny"}`), and whatever it asks anyway is turned down. It starts in the Environment's temp directory rather than the working copy, so the Project's instructions don't load. It is sent one prompt and closed after its answer.

Each check sends the open Highlights and the turns since the last check: the user's messages, the agent's replies, the tool calls by name and target (without their output), and the Approval requests and questions with how they were answered. It never sends the whole conversation, so a check costs about the same however long the Session gets. When the turns since the last check are too long to send (more than about 60,000 characters, after long messages are cut), the oldest are left out and the prompt says so: they are passed over rather than checked later. The model answers in JSON, adding Highlights or resolving open ones with a reason. It never rewrites one.

The costs:
- A process starts for each turn checked: about 400 MB for a few seconds. Checks run in the background and never hold up the Session. A turn that ends during a check is covered by the next one, so no turn is checked twice.
- A check that fails, because the model is unavailable or its answer isn't JSON, leaves its turns for the next check, and the Panel says why.
- The checks' usage goes into a table of its own (`highlight_usage`). The dashboard counts it in its totals, per day, per Project and per model, but not in a Session's own usage, its context or the top Sessions: it is a different model with a different context.
