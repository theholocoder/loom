---
name: drive-loom
description: Drive the real Loom app headless in a sandbox (seeded repos, scripted agent and gh) through Playwright, taking screenshots. Use to see a change working in the app, to screenshot it, or to explore its UX.
---

`apps/client/e2e/drive.ts` launches the built app with a temporary profile and the seam A stand-ins, so nothing real is touched and no model is called. It serves an HTTP endpoint that runs your Playwright script against the app window.

## Steps

1. **Build** what you changed: `pnpm bridge:build && pnpm --filter @loom/client build`. The driver runs `out/`, so a stale build shows stale UI.
2. **Start** it in the background, with a port and an output folder of your own (so parallel agents don't collide), and wait for the `drive ready` line:
   ```bash
   cd apps/client && LOOM_DRIVE_PORT=7788 LOOM_DRIVE_OUT=<your scratch folder> node e2e/drive.ts > <your scratch folder>/drive.log 2>&1 &
   ```
   The `drive ready` line prints `state`: the repo paths, the profile and the sandbox folder. `LOOM_DRIVE_HEADED=1` shows the window instead.
3. **Drive** it by posting the body of an async function:
   ```bash
   curl -s --data-binary @- http://127.0.0.1:7788/run <<'JS'
   await window.getByRole('button', { name: 'New' }).click();
   return { shot: await shot('new-menu'), aria: await window.locator('body').ariaSnapshot() };
   JS
   ```
   Look at each screenshot with your image-reading tool: the accessibility snapshot finds controls, the screenshot shows how they look.
4. **Stop** it with `curl -s -X POST http://127.0.0.1:7788/stop`: it closes the app and removes the sandbox. Done when that prints `stopped`.

## In scope of a script

- `window`: the Playwright `Page` of the app window, 1400×900 (`window.setViewportSize` to resize). Drive it as a user would: locators by role, `window.keyboard`, `window.mouse`, `click({ button: 'right' })`.
- `app`: the Playwright `ElectronApplication`, for main-process work such as stubbing dialogs.
- `machine`: the seam A `Machine` (`apps/client/test/seam-a/machine.ts`).
- `shot(name)`: saves a PNG under `<out>/shots/` and returns its path.
- `state`, `logs` (the app's stdout and stderr), `consoleErrors` (renderer errors and warnings).
- `globalThis.loom` inside `window.evaluate`: the typed API from `src/shared/api.ts`, to set up Projects and Sessions quickly (`projects.link`, `sessions.create`). Wait for the native agent to be ready first: subscribe to `environments` until `agent.state === 'ready'`.

## The sandbox

- **Repos** (`state.repos`): `billing` is on GitHub through the `gh` stand-in, with branch `loom/12-invoices-show-the-wrong-currency` holding Merge request #40 (a failing check, a review asking for changes); its `origin` is unreachable, so fetches fail. `web` has a local bare `origin`, so fetches work. `docs` has no `origin`. They are real git repos: change files or run git in them to set up a case.
- **The agent** is scripted: each agent process plays one turn per prompt, in order: (1) thinking, tool calls including a failed one, an edit and a Markdown reply; (2) an Approval request, then a two-part question; (3) a run that stays Working until stopped; (4) a provider error. Past the end it says nothing. A reopened or restarted Session starts a new process at turn 1. Judge how Loom shows these turns, not their wording.
- **Native dialogs** can't show headless: stub them before the click, e.g. `await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, state.repos.web)`, and `dialog.showMessageBox` the same way.
- **The app's PATH** is a minimal sandbox one: its terminal lacks tools such as `ls`.
