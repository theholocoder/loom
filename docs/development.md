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

Seam A never runs the real `gh` or `glab`: it puts scripted stand-ins on the Environment's PATH (`apps/client/test/seam-a/stand-ins`). On Unix it also stands in for WSL (`Machine.installWsl`): a `wsl.exe` script, which the native bridge is pointed at with `LOOM_TEST_WSL`, runs each distro's commands on the test machine under a home of its own.

### Forge contract suite

An opt-in suite (`apps/client/test/forge-contract`) checks those stand-ins against the real CLIs. It runs your own signed-in `gh` and `glab` against sandbox repositories (read-only, each with at least one open issue and one Merge request in any state), checks Loom reads their output (the issue picker's list, the Issue Panel's read of an issue, and the Merge request Panel's read), records it under `apps/client/test/forge-contract/recordings/`, and checks the stand-in prints the same shape. It is skipped unless `LOOM_FORGE_CONTRACT=1`; each Forge also needs its sandbox as `host/owner/repo`:

```sh
LOOM_FORGE_CONTRACT=1 \
LOOM_FORGE_CONTRACT_GITHUB=github.com/you/loom-sandbox \
LOOM_FORGE_CONTRACT_GITLAB=gitlab.com/you/loom-sandbox \
pnpm --filter @loom/client exec vitest run --project forge-contract
```

### Real OpenCode contract suite

Another opt-in suite (`apps/client/test/opencode-contract`) runs Loom's ACP adapter against your own installed, signed-in `opencode`, with your own OpenCode config. It checks that the approval rules Loom passes in `OPENCODE_CONFIG_CONTENT` ask what seam A's `opencode acp` stand-in assumes: a shell command under the `shell` rule, a write outside the working copy, and nothing for work inside it. Everything it asks is rejected. It also checks the `model` and `effort` config options Loom reads and switches, without a prompt, and that a call of Loom's `link_merge_request` tool reaches Loom, made directly or from a Code Mode script (it needs the bridge built: `pnpm bridge:build`). It spends a few prompts of your default model, and is skipped unless `LOOM_OPENCODE_CONTRACT=1`:

```sh
LOOM_OPENCODE_CONTRACT=1 pnpm --filter @loom/client exec vitest run --project opencode-contract
```

## Packaging and releasing

`just package` builds the installer for this machine into `apps/client/dist`: a Linux x64 AppImage, or a Windows x64 per-user NSIS installer (no admin rights). Both are unsigned, and carry the `loom-bridge` binary in their resources (`resources/bridge`); the Windows installer carries the Linux one too, which Loom installs into each WSL distro it works in. electron-builder's config is `apps/client/electron-builder.yml`. Only main's run-time packages are `dependencies` in `apps/client/package.json`: what the renderer uses is bundled by Vite, so it belongs in `devDependencies` and stays out of the installer.

`node scripts/self-test-package.mjs <AppImage or installer>` launches a build once in self-test mode (`LOOM_SELF_TEST=1`, `apps/client/src/main/self-test.ts`): Loom starts, opens its database, connects its bridge, prints the result and quits, exiting 1 if any of it failed. CI's Package job (`.github/workflows/package.yml`) runs it on every change, for each installer.

### SQLite on older Linux

better-sqlite3's Linux prebuild needs glibc 2.34 (Ubuntu 22.04, Debian 12, RHEL 9), while Electron runs on older Linux. Where it can't load, Loom opens its database with Node's built-in `node:sqlite` instead (`apps/client/src/main/storage/sqlite.ts`); both open the same file the same way. The oldest Linux Loom supports is RHEL 8 and its rebuilds (glibc 2.28): CI runs the AppImage's self-test in a Rocky Linux 8 container (`scripts/self-test-old-linux.sh`) to check the fallback takes over there. `LOOM_SQLITE_DRIVER=node:sqlite` forces the fallback anywhere, and seam A tests it (`sqlite-driver.test.ts`).

### Updates

Packaged builds update themselves with electron-updater from this repository's GitHub Releases, stable releases only (`apps/client/src/main/updates.ts`). Loom looks for an update at startup and every 4 hours, and downloads it in the background. It installs on the next quit, or when the user clicks **Restart to update** in the sidebar footer, which asks first if Sessions are Working. Loom never restarts on its own. There are no updates in development, in the self-test, with `LOOM_NO_UPDATES=1`, or on Linux outside the AppImage.

### Error reporting

Release builds report errors, native crashes, warnings and the user's feedback to Sentry (ADR 0011): main, the preload and the renderer to the `loom` project (`apps/client/src/main/telemetry.ts`, `src/renderer/telemetry.ts`), the bridge to `loom-bridge` (`bridge/report`), which main turns on through the bridge's environment. Everything is scrubbed first (`src/shared/scrub.ts`, `bridge/report/scrub.go`): change those, and their tests, before sending anything new. Development, the tests and the self-test report nothing; `LOOM_SENTRY=1` turns reporting on, to see what a change sends (`just dev-report` runs the app with it, and the drive-loom driver passes it on); such reports are in the `development` environment, a packaged build's in `production`, and `LOOM_SENTRY=0` turns a release build's off.

The Release workflow uploads the source maps of each build to Sentry and leaves them out of the installer. It needs a `SENTRY_AUTH_TOKEN` repository secret: an organization token of TheHolocoder's Sentry organization. Without it, releases still build, with no source maps.

### Releasing

Run the Release workflow (`.github/workflows/release.yml`) on `main`: in GitHub, Actions → Release → Run workflow, or `gh workflow run release.yml`. By default (`bump=auto`) it picks the version from the Conventional Commits since the last `vX.Y.Z` tag: a breaking change (`type!:` or a `BREAKING CHANGE:` footer) is major, otherwise a `feat` is minor, otherwise patch; before 1.0.0 a breaking change is only minor. `-f bump=patch` (`minor`, `major`) or `-f version=X.Y.Z` overrides it, and the run's summary lists the commits it read. It sets the version in `apps/client/package.json` (the bridge and the app are both stamped with it), commits that to `main` as `chore(release): vX.Y.Z` and tags it, then builds and self-tests both installers and publishes them with their update metadata (`latest.yml`, `latest-linux.yml`) as the latest GitHub Release. Versions are plain `X.Y.Z`: there are no prereleases. If the build fails after the tag is pushed, fix what failed and re-run the failed jobs: the tag stays. `-f dry_run=true` runs everything but the push and the release, from any branch (`--ref <branch>`), and builds that branch at its current version: use it to check a change to the workflow before merging it.

**Manual check: update from the previous release.** Run the workflow with `draft` ticked, so the release is a draft electron-updater doesn't see. Install the previous release and point it at the draft's build, or build the new one locally (`just package`) and serve it as an update. Check that the update downloads, that **Restart to update** shows, that it installs on quit and on the button, that the button starts the new version again (on Linux too: Loom starts the new AppImage itself, since Electron's `app.relaunch` can't, `apps/client/src/main/appimage-restart.ts`; 0.1.0, from before that, only installs and closes), that Loom doesn't restart on its own, and that the Projects and Sessions are still there. Then publish the draft.
