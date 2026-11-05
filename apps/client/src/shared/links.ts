// The links Loom opens, always in the system browser.

/** Whether `url` is one Loom opens in the system browser: http or https. */
export function isWebLink(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'https:' || protocol === 'http:';
}
