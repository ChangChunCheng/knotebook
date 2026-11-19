/** The only place the resource identifier is compared. The `issuer` parameter keeps this pure: don't restore the single-argument form. */

export function canonicalResource(issuer: string): string {
  return `${issuer}/api/mcp`;
}

/** `new URL` lowercases scheme/host and drops the default port; the path is case-sensitive with no trailing-slash stripping, and query/fragment make it a different identifier. */
export function isCanonicalResource(input: string | undefined, issuer: string): boolean {
  if (input === undefined) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.search !== "" || url.hash !== "") return false;
  return `${url.origin}${url.pathname}` === canonicalResource(issuer);
}
