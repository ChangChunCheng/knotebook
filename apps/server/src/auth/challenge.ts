/**
 * resource_metadata always points at /api/mcp (one resource identifier). This deviates from RFC 9728 §3.3 on purpose:
 * strict clients drop the metadata they got from `/api/notes`, but `/api/mcp` is the MCP client's only entry anyway.
 * Don't restrict it to `/api/mcp`: newer endpoints' 401s would carry no discovery info (docs/known-limitations.md).
 * `scope` is the advertised set, not the single `required`: MCP clients request only what is listed, so `/api/mcp` must list
 * `notes:read notes:write notes:move notes:delete` or the consent page never offers the missing one.
 * Params are separated by `, ` and every value is double-quoted; tests assert each param, not the whole string.
 * Values are NOT escaped: today every input is server-controlled (parsed origin, route literal, type union), but never echo request data
 * in: a `"` would inject a `resource_metadata=` pointing at an attacker's authorization server
 * `issuer` is the origin without trailing slash (not `publicUrl.href`, which would give `//`).
 */
export interface ChallengeInput {
  issuer: string;
  scope: string;
  error?: "invalid_token" | "insufficient_scope";
}

export function buildBearerChallenge({ issuer, scope, error }: ChallengeInput): string {
  const params = [
    ...(error === undefined ? [] : [`error="${error}"`]),
    `scope="${scope}"`,
    `resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp"`,
  ];
  return `Bearer ${params.join(", ")}`;
}

/** Not `buildBearerChallenge`: it always adds `resource_metadata`, which would send OAuth clients into discovery, and transfer tokens have no scope. Values are not escaped. */
export function buildTransferChallenge(error?: "invalid_token"): string {
  return error === undefined ? `Bearer realm="knotebook-transfer"` : `Bearer realm="knotebook-transfer", error="${error}"`;
}
