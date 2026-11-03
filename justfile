# Loom development tasks. Tool versions come from mise.toml (`mise install`).

# List every recipe
default:
    @just --list

# Install tool versions and dependencies
install:
    mise install
    pnpm install
    # pnpm skips Electron's postinstall when it already considers the package built,
    # so a failed binary download is never retried; re-run it if the binary is missing.
    compgen -G "node_modules/.pnpm/electron@*/node_modules/electron/path.txt" >/dev/null || pnpm rebuild electron

# Run every test: Go bridge (seam C), main and renderer (seams A and B), Electron smoke tests
test:
    pnpm test
    pnpm test:e2e

# Typecheck the Client, vet the bridge and check its formatting
lint:
    pnpm typecheck
    cd bridge && go vet ./...
    @test -z "$(cd bridge && gofmt -l .)" || (echo "gofmt needed on:" && cd bridge && gofmt -l . && exit 1)

# Build the bridge and run the app in dev mode
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    # Electron only picks Wayland when XDG_SESSION_TYPE says so, which some
    # terminals don't pass on; without X it then exits for lack of a $DISPLAY.
    if [[ -n "${WAYLAND_DISPLAY:-}" && -z "${XDG_SESSION_TYPE:-}" ]]; then
        export XDG_SESSION_TYPE=wayland
    fi
    exec pnpm dev

alias start := dev
