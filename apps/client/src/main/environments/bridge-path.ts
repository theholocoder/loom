import { join } from 'node:path';

/** The loom-bridge binary for this machine inside `dir`, as built by scripts/build-bridge.mjs. */
export function bridgeBinaryPath(dir: string, platform = process.platform, arch = process.arch): string {
  return join(dir, `loom-bridge-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
}
