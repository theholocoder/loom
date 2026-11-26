export const NATIVE_ENVIRONMENT_ID = 'native';

const WSL_PREFIX = 'wsl:';

export function wslEnvironmentId(distro: string): string {
  return `${WSL_PREFIX}${distro}`;
}

export function distroOf(environmentId: string): string | undefined {
  return environmentId.startsWith(WSL_PREFIX) ? environmentId.slice(WSL_PREFIX.length) : undefined;
}

const WSL_SHARE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;

/**
 * `path` as the distro's own path: one Windows shows for the distro
 * (`\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…`) without that prefix,
 * and a Windows drive's (`C:\…`) under `/mnt/<drive>`. Rejects one of another
 * distro.
 */
export function pathInDistro(distro: string, path: string): string {
  const share = WSL_SHARE.exec(path);
  if (share) {
    const shareDistro = share[1]!;
    if (shareDistro.toLowerCase() !== distro.toLowerCase()) throw new Error(`${path} is in ${shareDistro}, not ${distro}`);
    return `/${parts(share[2]!).join('/')}`;
  }
  const drive = DRIVE.exec(path);
  if (drive) {
    return ['', 'mnt', drive[1]!.toLowerCase(), ...parts(drive[2] ?? '')].join('/');
  }
  return path;
}

/** The distro's `path` as Windows programs open it: `\\wsl.localhost\<distro>\…`. */
export function windowsPathOf(distro: string, path: string): string {
  return ['\\\\wsl.localhost', distro, ...parts(path)].join('\\');
}

/** A distro's path on a Windows drive (`/mnt/c/…`) as Windows writes it (`C:\…`). */
export function drivePathOf(path: string): string {
  const [drive, ...rest] = parts(path).slice(1);
  return [`${drive!.toUpperCase()}:`, ...rest].join('\\');
}

/** Whether a distro's `path` is on a Windows drive (`/mnt/c/…`), which is slow to work in from the distro. */
export function onWindowsDrive(path: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(path);
}

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}
