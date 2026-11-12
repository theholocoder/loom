# Loom

A local desktop workspace for AI-assisted software development. See `CONTEXT.md` for the domain language and `docs/adr/` for the decisions behind the design.

## Layout

- `apps/client`: the Electron Client (TypeScript, electron-vite, React).
  - `src/main`: main, which owns all state; `src/main/loom.ts` builds it with no Electron in it.
  - `src/preload`, `src/renderer`: the UI, which talks to main only through the typed API in `src/shared/api.ts`.
- `bridge`: `loom-bridge`, the Go helper main drives each Environment through (ADR 0008).

## Development

Tool versions are pinned in `mise.toml`. Common tasks are in the `justfile` (`just` lists them):

```bash
just install        # mise install, then pnpm install
just dev            # build the bridge and run the app (alias: just start)
just lint           # typecheck, go vet, gofmt check
just test           # seams C, A and B, then the Electron smoke tests
```

With no display, run the smoke tests headless: `LOOM_SMOKE_HEADLESS=1 just test`.

## Test seams

- **Seam A** (`apps/client/test/seam-a`): main driven in-process through the typed API, with a temporary `userData`, the real bridge and a manual clock.
- **Seam B** (`apps/client/test/seam-b`, `apps/client/e2e`): the renderer against a fake main, plus Electron smoke tests of the whole app.
- **Seam C** (`bridge/protocol`): Go tests at the bridge protocol boundary.

Seam A never runs the real `gh` or `glab`: it puts scripted stand-ins on the Environment's PATH (`apps/client/test/seam-a/stand-ins`).

### Forge contract suite

An opt-in suite (`apps/client/test/forge-contract`) checks those stand-ins against the real CLIs. It runs your own signed-in `gh` and `glab` against sandbox repositories (read-only, each with at least one open issue and one Merge request in any state), checks Loom reads their output (the issue picker's list, the Issue Panel's read of an issue, and the Merge request Panel's read), records it under `apps/client/test/forge-contract/recordings/`, and checks the stand-in prints the same shape. It is skipped unless `LOOM_FORGE_CONTRACT=1`; each Forge also needs its sandbox as `host/owner/repo`:

```sh
LOOM_FORGE_CONTRACT=1 \
LOOM_FORGE_CONTRACT_GITHUB=github.com/you/loom-sandbox \
LOOM_FORGE_CONTRACT_GITLAB=gitlab.com/you/loom-sandbox \
pnpm --filter @loom/client exec vitest run --project forge-contract
```

### Real OpenCode contract suite

Another opt-in suite (`apps/client/test/opencode-contract`) runs Loom's ACP adapter against your own installed, signed-in `opencode`, with your own OpenCode config. It checks that the approval rules Loom passes in `OPENCODE_CONFIG_CONTENT` ask what seam A's `opencode acp` stand-in assumes: a shell command under the `shell` rule, a write outside the working copy, and nothing for work inside it. Everything it asks is rejected. It also checks the `model` and `effort` config options Loom reads and switches, without a prompt. It spends a few prompts of your default model, and is skipped unless `LOOM_OPENCODE_CONTRACT=1`:

```sh
LOOM_OPENCODE_CONTRACT=1 pnpm --filter @loom/client exec vitest run --project opencode-contract
```
