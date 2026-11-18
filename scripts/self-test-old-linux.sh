#!/bin/sh
# Runs the AppImage's self-test on Rocky Linux 8 (glibc 2.28), the oldest
# Linux Loom supports: older than the glibc 2.34 better-sqlite3's prebuild
# needs, so Loom must fall back to node:sqlite there. Run in a container:
#
#   docker run --rm -v "$PWD/apps/client/dist:/dist:ro" -v "$PWD/scripts:/scripts:ro" \
#     rockylinux:8 sh /scripts/self-test-old-linux.sh
set -eu
# The libraries Electron links to, which a desktop install has.
dnf install -y -q nss atk at-spi2-atk gtk3 mesa-libgbm alsa-lib libXScrnSaver libxshmfence libdrm libxkbcommon >/dev/null
ldd --version | head -n 1
appimage=$(ls /dist/Loom-*-x86_64.AppImage)
userdata=$(mktemp -d)
code=0
LOOM_SELF_TEST=1 LOOM_USER_DATA_DIR="$userdata" timeout 120 "$appimage" --appimage-extract-and-run --no-sandbox --ozone-platform=headless >/tmp/loom.log 2>&1 || code=$?
grep -v appimage_extracted_ /tmp/loom.log || true
# The fallback must be what ran: better-sqlite3 loading here would mean this no longer tests it.
grep -q 'opens its database with node:sqlite' /tmp/loom.log || { echo 'better-sqlite3 loaded: the node:sqlite fallback was not tested'; exit 1; }
exit "$code"
