// Makes sure Electron's binary is installed, downloading it if not. Electron
// fetches its binary in its own postinstall, which pnpm skips once it
// considers the package built: a download that failed or was skipped on a
// machine is then never retried, and electron-vite fails with "Electron
// uninstall". This runs Electron's own install.js, which does nothing when
// the binary is already there, so it is cheap to run before every launch.
// Runs on `pnpm install` (root postinstall) and before `dev` and `test:e2e`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Electron is the Client's dependency: resolved from there, as electron-vite does.
const require = createRequire(join(root, 'apps/client/package.json'));

let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  // Not installed yet, as during a first `pnpm install` before the Client's dependencies are linked.
  process.exit(0);
}

/** The Electron executable path.txt names, if it and the binary are there. */
function installedBinary() {
  const pathFile = join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) return undefined;
  const binary = join(electronDir, 'dist', readFileSync(pathFile, 'utf8'));
  return existsSync(binary) ? binary : undefined;
}

if (installedBinary()) process.exit(0);

console.log(`Electron's binary is missing from ${electronDir}; downloading it…`);
try {
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { cwd: electronDir, stdio: 'inherit' });
} catch {
  // install.js has printed why.
}
if (!installedBinary()) {
  console.error(
    `Electron's binary is still missing from ${electronDir}.\n` +
      'Check your network (or ELECTRON_MIRROR / electron_config_cache), then run `pnpm install` again.',
  );
  process.exit(1);
}
console.log('Electron installed.');
