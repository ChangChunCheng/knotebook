// A lattice, not a chain: move and delete don't include each other, so compare with narrowerScope/hasScope, never
// `indexOf`. move/delete require write. The DB scope CHECKs and zod enums follow this list (scope-check-sync.test.ts).
// The stored form is five fixed literals in read, write, move, delete order; write always includes read explicitly.
// Add new scopes the same way (split into words, intersect, join in the fixed order).
export const TOKEN_SCOPES = [
  "notes:read",
  "notes:read notes:write",
  "notes:read notes:write notes:move",
  "notes:read notes:write notes:delete",
  "notes:read notes:write notes:move notes:delete",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export type ScopeName = "notes:read" | "notes:write" | "notes:move" | "notes:delete";

/** No move/delete: `bearer.ts` picks its limiter only as write vs other; move and delete are checked at the MCP tool layer. */
export type RequiredScope = "notes:read" | "notes:write";

// Whole space-separated words only (`notes:write-all` must not grant write; tabs don't split, failing closed). Unknown
// values are ignored (RFC 6749 §3.3), so it never returns null; empty gives `notes:read`. move/delete without write give
// `notes:read` rather than granting unrequested write (`notes:read notes:move` isn't a stored form; the DB CHECK rejects it).
// Responses echo this output, never ignored values. Identity on the five stored forms, because bearer.ts and
// api-tokens.ts pass DB values through it.
export function normalizeScope(input: string | null | undefined): TokenScope {
  const parts = (input ?? "").split(" ");
  if (!parts.includes("notes:write")) return "notes:read";
  return [
    "notes:read",
    "notes:write",
    ...(parts.includes("notes:move") ? ["notes:move"] : []),
    ...(parts.includes("notes:delete") ? ["notes:delete"] : []),
  ].join(" ") as TokenScope;
}

/** Values outside the five forms count as `notes:read` (inputs come from a text column cast to TokenScope); don't
 * normalizeScope them, which would widen a bare `notes:write`. */
export function narrowerScope(a: TokenScope, b: TokenScope): TokenScope {
  const canon = (s: TokenScope): TokenScope => ((TOKEN_SCOPES as readonly string[]).includes(s) ? s : "notes:read");
  const pa = new Set(canon(a).split(" "));
  return normalizeScope(
    canon(b)
      .split(" ")
      .filter((p) => pa.has(p))
      .join(" "),
  );
}

// Membership test, not a hard-coded hierarchy (which would miss write in the read+write+move form). This is the final
// authorization check and `stored` is a cast text column, so it doesn't rely on the DB CHECK.
export function hasScope(stored: TokenScope, required: ScopeName): boolean {
  return stored.split(" ").includes(required);
}

/** Idle OAuth apps are cleaned up after this many days; web shows the resulting expiry. */
export const OAUTH_APP_IDLE_DAYS = 30;

export interface ApiTokenDto {
  id: string;
  kind: "pat" | "oauth";
  /** For oauth, the client-claimed name, unverified: the UI must say so. */
  name: string;
  /** Never null: derived from `name` (deriveAgentLabel) when the column is NULL. */
  agentLabel: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  /** null: never expires (the PAT default). For oauth rows, the access token's expiry (~24 h), not the grant's; web doesn't show it. */
  expiresAt: string | null;
  clientId: string | null;
}

/** The only response that ever contains the plaintext token. */
export interface CreatedApiTokenDto extends ApiTokenDto {
  token: string;
}

export interface OauthRequestDto {
  /** Client-claimed, unverified: bidi-isolate when rendering. */
  clientName: string;
  /** Includes the port on purpose, so users see where they'll be sent. */
  redirectHost: string;
  scope: TokenScope;
  scopes: string[];
  /** Always `existingScope !== null`. */
  replacesExisting: boolean;
  /** Load-time snapshot, only for the consent page's default checkboxes; the server grant doesn't depend on it. */
  existingScope: TokenScope | null;
}
