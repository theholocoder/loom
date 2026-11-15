// Launches a packaged build once in self-test mode: Loom starts, opens its
// database, connects its bridge, says so and quits (see
// apps/client/src/main/self-test.ts). Exits with Loom's exit code.
//
//   node scripts/self-test-package.mjs <Loom-….AppImage | Loom-Setup-….exe>
//
// The Windows installer is installed first, silently and for this user only,
// and the installed Loom is launched. The environment is passed on, so
// LOOM_SQLITE_DRIVER=node:sqlite tests the fallback driver.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TIMEOUT_MS = 120_000;

const artifact = process.argv[2];
if (!artifact || !existsSync(artifact)) {
  console.error('usage: node scripts/self-test-package.mjs <AppImage | NSIS installer>');
  process.exit(2);
}

/** The executable to launch, and its arguments. */
function launchLine() {
  if (artifact.endsWith('.AppImage')) {
    // GitHub's runners have no FUSE to mount it, nor a display, nor Chromium's sandbox.
    return { command: resolve(artifact), args: ['--appimage-extract-and-run', '--no-sandbox', '--ozone-platform=headless'] };
  }
  if (artifact.endsWith('.exe')) {
    execFileSync(resolve(artifact), ['/S'], { stdio: 'inherit' });
    const programs = join(process.env.LOCALAPPDATA ?? '', 'Programs');
    const installed = readdirSync(programs)
      .map((dir) => join(programs, dir, 'Loom.exe'))
      .find((exe) => existsSync(exe));
    if (!installed) throw new Error(`Loom.exe is not under ${programs} after installing ${artifact}`);
    console.log(`installed ${installed}`);
    return { command: installed, args: [] };
  }
  throw new Error(`${artifact} is neither an AppImage nor an NSIS installer`);
}

const { command, args } = launchLine();
const userDataDir = mkdtempSync(join(tmpdir(), 'loom-self-test-'));
// Into a file, not a pipe: from an AppImage, what Loom prints to a pipe can be lost.
const logFile = join(userDataDir, 'self-test.log');
const log = openSync(logFile, 'w');
const child = spawn(command, args, { env: { ...process.env, LOOM_SELF_TEST: '1', LOOM_USER_DATA_DIR: userDataDir }, stdio: ['ignore', log, log] });
const timer = setTimeout(() => {
  console.error(`Loom did not quit within ${TIMEOUT_MS / 1000} s`);
  child.kill();
}, TIMEOUT_MS);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  closeSync(log);
  // Not the file list --appimage-extract-and-run prints as it extracts, which
  // isn't always cut into lines: a path, or the end of one, with no spaces.
  for (const line of readFileSync(logFile, 'utf8').split(/[\r\n]+/)) {
    const said = line.replace(/\S*appimage_extracted_[0-9a-f]*(\/\S*)?/g, '').trim();
    if (said && !/^\S*\/\S*$/.test(said)) console.log(said);
  }
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(`Loom exited with ${signal ?? code}`);
  process.exit(code ?? 1);
});
