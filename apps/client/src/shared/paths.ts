export function slashed(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

export function baseName(path: string): string {
  return slashed(path).split('/').at(-1) || path;
}
