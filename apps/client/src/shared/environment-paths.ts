import type { Checkout } from './api';
import { distroOf } from './environment-ids';

const WSL_SHARE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;
const MOUNTED_DRIVE = /^\/mnt\/([a-z])(?:\/(.*))?$/i;

/**
 * `path` as the Environment's own. In a WSL distro, one Windows shows for the
 * distro (`\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…`) loses that
 * prefix, and a Windows drive's (`C:\…`) goes under `/mnt/<drive>`; one of
 * another distro is rejected. Elsewhere it is left as it is.
 */
export function pathInEnvironment(environmentId: string, path: string): string {
  const distro = distroOf(environmentId);
  if (!distro) return path;
  const share = WSL_SHARE.exec(path);
  if (share) {
    const shareDistro = share[1]!;
    if (shareDistro.toLowerCase() !== distro.toLowerCase()) throw new Error(`${path} is in ${shareDistro}, not ${distro}`);
    return `/${parts(share[2]!).join('/')}`;
  }
  const drive = DRIVE.exec(path);
  return drive ? ['', 'mnt', drive[1]!.toLowerCase(), ...parts(drive[2] ?? '')].join('/') : path;
}

/** A distro's `path` as Windows programs open it: `C:\…` on a Windows drive, `\\wsl.localhost\<distro>\…` otherwise. */
export function windowsPath(distro: string, path: string): string {
  const drive = MOUNTED_DRIVE.exec(path);
  if (drive) return [`${drive[1]!.toUpperCase()}:`, ...parts(drive[2] ?? '')].join('\\');
  return ['\\\\wsl.localhost', distro, ...parts(path)].join('\\');
}

/** Whether the checkout is a WSL distro's on a Windows drive (`/mnt/c/…`), which git and the agent are slow in from the distro. */
export function isSlowCheckout({ environmentId, path }: Checkout): boolean {
  return !!distroOf(environmentId) && MOUNTED_DRIVE.test(path);
}

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}
