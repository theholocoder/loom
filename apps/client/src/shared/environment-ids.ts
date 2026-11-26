export const NATIVE_ENVIRONMENT_ID = 'native';

const WSL_PREFIX = 'wsl:';

export function wslEnvironmentId(distro: string): string {
  return `${WSL_PREFIX}${distro}`;
}

export function distroOf(environmentId: string): string | undefined {
  return environmentId.startsWith(WSL_PREFIX) ? environmentId.slice(WSL_PREFIX.length) : undefined;
}
