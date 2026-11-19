import type { TokenScope } from "@knotebook/shared";

export interface ScopeChecks {
  write: boolean;
  move: boolean;
  delete: boolean;
}

/** Move and delete without edit → read-only (fail-closed, same direction as shared `normalizeScope`). Part order must match the TOKEN_SCOPES literals; the cast hides a mismatch. */
export function scopeFromChecks(write: boolean, move: boolean, del: boolean): TokenScope {
  if (!write) return "notes:read";
  const parts = ["notes:read", "notes:write", ...(move ? ["notes:move"] : []), ...(del ? ["notes:delete"] : [])];
  return parts.join(" ") as TokenScope;
}

export function checksFromScope(scope: TokenScope): ScopeChecks {
  const parts = scope.split(" ");
  const write = parts.includes("notes:write");
  return { write, move: write && parts.includes("notes:move"), delete: write && parts.includes("notes:delete") };
}
