# Loom

A local desktop workspace for AI-assisted software development. See `CONTEXT.md` for the domain language and `docs/adr/` for the decisions behind the design.

## Layout

- `apps/client`: the Electron Client (TypeScript, electron-vite, React).
  - `src/main`: main, which owns all state; `src/main/loom.ts` builds it with no Electron in it.
  - `src/preload`, `src/renderer`: the UI, which talks to main only through the typed API in `src/shared/api.ts`.
- `bridge`: `loom-bridge`, the Go helper main drives each Environment through (ADR 0008).

## Development

Tool versions are pinned in `mise.toml` (`mise install`).

```bash
pnpm install
pnpm dev            # build the bridge and run the app
pnpm typecheck
pnpm test           # seam C (Go), then seams A and B (Vitest)
pnpm test:e2e       # Electron smoke tests (Playwright); set LOOM_SMOKE_HEADLESS=1 with no display
```

## Test seams

- **Seam A** (`apps/client/test/seam-a`): main driven in-process through the typed API, with a temporary `userData`, the real bridge and a manual clock.
- **Seam B** (`apps/client/test/seam-b`, `apps/client/e2e`): the renderer against a fake main, plus Electron smoke tests of the whole app.
- **Seam C** (`bridge/protocol`): Go tests at the bridge protocol boundary.
