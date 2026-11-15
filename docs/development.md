# Developing Loom

See [`CONTEXT.md`](../CONTEXT.md) for the domain language and [`docs/adr/`](adr/) for the decisions behind the design. The [README](../README.md) covers what Loom is and how to run it.

## Layout

- `apps/client`: the Electron Client (TypeScript, electron-vite, React).
  - `src/main`: main, which owns all state; `src/main/loom.ts` builds it with no Electron in it.
  - `src/preload`, `src/renderer`: the UI, which talks to main only through the typed API in `src/shared/api.ts`.
  - `resources`: the app icon.
- `bridge`: `loom-bridge`, the Go helper main drives each Environment through (ADR 0008).
- `assets`: the logo (`logo.svg`, `logo-dark.svg` for dark backgrounds) and the app icon's source (`icon.svg`).

## Tasks

Common tasks are in the `justfile` (`just` lists them):

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

## Packaging and releasing

`just package` builds the installer for this machine into `apps/client/dist`: a Linux x64 AppImage, or a Windows x64 per-user NSIS installer (no admin rights). Both are unsigned, and carry the `loom-bridge` binary in their resources (`resources/bridge`). electron-builder's config is `apps/client/electron-builder.yml`. Only main's run-time packages are `dependencies` in `apps/client/package.json`: what the renderer uses is bundled by Vite, so it belongs in `devDependencies` and stays out of the installer.

`node scripts/self-test-package.mjs <AppImage or installer>` launches a build once in self-test mode (`LOOM_SELF_TEST=1`, `apps/client/src/main/self-test.ts`): Loom starts, opens its database, connects its bridge, prints the result and quits, exiting 1 if any of it failed. CI's Package job (`.github/workflows/package.yml`) runs it on every change, for each installer.

### SQLite on older Linux

better-sqlite3's Linux prebuild needs glibc 2.34 (Ubuntu 22.04, Debian 12, RHEL 9), while Electron runs on older Linux. Where it can't load, Loom opens its database with Node's built-in `node:sqlite` instead (`apps/client/src/main/storage/sqlite.ts`); both open the same file the same way. The oldest Linux Loom supports is RHEL 8 and its rebuilds (glibc 2.28): CI runs the AppImage's self-test in a Rocky Linux 8 container (`scripts/self-test-old-linux.sh`) to check the fallback takes over there. `LOOM_SQLITE_DRIVER=node:sqlite` forces the fallback anywhere, and seam A tests it (`sqlite-driver.test.ts`).

### Updates

Packaged builds update themselves with electron-updater from this repository's GitHub Releases, stable releases only (`apps/client/src/main/updates.ts`). Loom looks for an update at startup and every 4 hours, and downloads it in the background. It installs on the next quit, or when the user clicks **Restart to update** in the sidebar footer, which asks first if Sessions are Working. Loom never restarts on its own. There are no updates in development, in the self-test, with `LOOM_NO_UPDATES=1`, or on Linux outside the AppImage.

### Releasing

1. Set the version in `apps/client/package.json` (the bridge and the app are both stamped with it), and merge that to `main`.
2. **Manual check: update from the previous release.** Install the previous release, then build the new one (`just package`) and serve it to that install as an update. Or publish it as a draft release first, and check the update before publishing the draft. Check that the update downloads, that **Restart to update** shows, that it installs on quit and on the button, that Loom doesn't restart on its own, and that the Projects and Sessions are still there.
3. Tag the merge commit `vX.Y.Z` and push the tag. The Release workflow (`.github/workflows/release.yml`) checks the tag matches the version, builds and self-tests both installers, and publishes them with their update metadata (`latest.yml`, `latest-linux.yml`) as the latest GitHub Release. Only plain `vX.Y.Z` tags release: there are no prereleases.
