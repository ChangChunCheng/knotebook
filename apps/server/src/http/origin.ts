// Two comparison semantics, not interchangeable: `isOriginAllowed` (app.ts) compares Origin with request.host (CSRF); `mcpOriginAllowed` compares both against the PUBLIC_URL host (DNS rebinding).

// Hand-written instead of `new URL().host`: request.host is a bare Host header with no scheme, and URL's default-port removal is scheme-bound while this comparison ignores the scheme.
export function stripDefaultPort(host: string): string {
  return host.replace(/:(?:80|443)$/, "");
}

// The other side is always the PUBLIC_URL host, never request.host: comparing two request-supplied values is a useless guard (a rebound evil.com makes Origin and Host equal).
// "null" and unparseable Origins are rejected; without the try/catch a bad value would be a 500, not 403.
export function mcpOriginAllowed(origin: string, requestHost: string, publicHost: string): boolean {
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const want = stripDefaultPort(publicHost);
  return stripDefaultPort(originHost) === want && stripDefaultPort(requestHost) === want;
}
