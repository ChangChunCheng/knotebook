import type { FastifyReply } from "fastify";

export function sendOauthError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  description: string
): FastifyReply {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .send({ error, error_description: description });
}

// Matched by URL prefix because `routeOptions.url` is undefined on unmatched routes. ⚠ Both prefixes are also in shared `EXCLUDED_PREFIXES`; change both.
export function isOauthScopedPath(pathname: string): boolean {
  for (const prefix of ["/oauth", "/.well-known"]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export const FORM_EXEMPT_ROUTES: ReadonlySet<string> = new Set(["POST /oauth/token"]);
