// Builds loom-bridge into bridge/dist/loom-bridge-<platform>-<arch>[.exe],
// stamped with the Client's version. Builds the host target by default, or
// every shipped target with --all.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'apps/client/package.json'), 'utf8'));

// Node's platform/arch names, which is how the Client looks the binary up.
const targets = [
  { platform: 'linux', arch: 'x64', goos: 'linux', goarch: 'amd64' },
  { platform: 'win32', arch: 'x64', goos: 'windows', goarch: 'amd64' },
];

const selected = process.argv.includes('--all')
  ? targets
  : targets.filter((t) => t.platform === process.platform && t.arch === process.arch);
if (selected.length === 0) {
  console.error(`loom-bridge has no build target for ${process.platform}-${process.arch}`);
  process.exit(1);
}

for (const t of selected) {
  const output = join(root, 'bridge/dist', `loom-bridge-${t.platform}-${t.arch}${t.goos === 'windows' ? '.exe' : ''}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', output, './cmd/loom-bridge'], {
    cwd: join(root, 'bridge'),
    env: { ...process.env, CGO_ENABLED: '0', GOOS: t.goos, GOARCH: t.goarch },
    stdio: 'inherit',
  });
  console.log(`built ${output}`);
}
