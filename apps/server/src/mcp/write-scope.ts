/**
 * Scope check, session bypass and `tokenWrite` charge are one function so a new write tool
 * can't copy only the charge half; each write tool calls it first. It runs before
 * `resolveRole`, like REST (a `none` 404 consumes `tokenWrite` there too); the `edit` limiter
 * is charged after the role check. The key is `token:${userId}`, same as `auth/bearer.ts`,
 * so MCP and REST share one count. The endpoint's preHandler declares `notes:read`, so
 * `auth/bearer.ts` charges only `tokenRead`; without this charge the documented token write limit
 * (`docs/api-tokens.md`) wouldn't apply to MCP writes.
 *
 * The scope branches are dead over HTTP (the list is the registry and already filtered), kept
 * as a net if registration-time filtering is removed; the exceptions are `copy_note` with
 * `group_id` (move branch) and the live `tokenWrite` charge. The model therefore never sees
 * `insufficient_scope`; the per-request `instructions` carry that remedy.
 * This is discipline: a new write tool that forgets the call turns no test red.
 */
import { hasScope } from "@knotebook/shared";
import { toolError, type ToolErrorResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

/** Remedy: enable the permission on the token row under Settings → authorization, then reconnect; the quoted text is the toggle label. */
export const INSUFFICIENT_SCOPE_MESSAGE =
  'This credential cannot change notes. Ask the user to turn on "Create and edit notes" (notes:write) for this credential via the pencil on its row in Settings → Authorization, then reconnect.';
const RATE_LIMITED_MESSAGE = "Too many writes with this credential right now. Wait a few minutes before writing again.";

/** One criterion for registration filtering, per-request `instructions` and `requireWriteScope`, so a tool can't be listed while instructions say read-only. `?? "notes:read"` fails closed. */
export function canWriteNotes(auth: Pick<McpToolCtx, "authKind" | "tokenScope">): boolean {
  return auth.authKind === "session" || hasScope(auth.tokenScope ?? "notes:read", "notes:write");
}

/** A non-null result must be returned as-is, with nothing else done (a rejection has no side effects). */
export function requireWriteScope(ctx: McpToolCtx): ToolErrorResult | null {
  // A session is the full identity: no scope check, no limiter (same as `auth/bearer.ts`).
  if (ctx.authKind === "session") return null;
  if (!canWriteNotes(ctx)) {
    return toolError("insufficient_scope", INSUFFICIENT_SCOPE_MESSAGE);
  }
  // After the scope check: a 403 doesn't consume the limiter.
  if (!ctx.limiters.tokenWrite.consume(`token:${ctx.userId}`)) {
    return toolError("too_many_requests", RATE_LIMITED_MESSAGE);
  }
  return null;
}

/** Write and move, not trusting upstream normalization: a drifted CHECK allowing `notes:read notes:move` must not pass. */
export function canMoveNotes(auth: Pick<McpToolCtx, "authKind" | "tokenScope">): boolean {
  return auth.authKind === "session" || (canWriteNotes(auth) && hasScope(auth.tokenScope ?? "notes:read", "notes:move"));
}

/** A non-null result must be returned as-is, with nothing else done (a rejection has no side effects). */
export function requireMoveScope(ctx: McpToolCtx, message: string): ToolErrorResult | null {
  if (ctx.authKind === "session") return null;
  if (!canWriteNotes(ctx)) return toolError("insufficient_scope", INSUFFICIENT_SCOPE_MESSAGE);
  if (!canMoveNotes(ctx)) return toolError("insufficient_scope", message);
  if (!ctx.limiters.tokenWrite.consume(`token:${ctx.userId}`)) return toolError("too_many_requests", RATE_LIMITED_MESSAGE);
  return null;
}

/** Write and delete, for the same reason as `canMoveNotes`. */
export function canDeleteNotes(auth: Pick<McpToolCtx, "authKind" | "tokenScope">): boolean {
  return auth.authKind === "session" || (canWriteNotes(auth) && hasScope(auth.tokenScope ?? "notes:read", "notes:delete"));
}

export const DELETE_SCOPE_MESSAGE =
  'Moving notes to the trash and restoring them needs the notes:delete scope, and this credential doesn\'t have it, so nothing was changed. ' +
  'Ask the user to turn on "Move to trash (can be restored)" (notes:delete) for this credential via the pencil on its row in ' +
  "Settings → Authorization, then reconnect.";

/** A non-null result must be returned as-is, with nothing else done (a rejection has no side effects). */
export function requireDeleteScope(ctx: McpToolCtx): ToolErrorResult | null {
  if (ctx.authKind === "session") return null;
  if (!canWriteNotes(ctx)) return toolError("insufficient_scope", INSUFFICIENT_SCOPE_MESSAGE);
  if (!canDeleteNotes(ctx)) return toolError("insufficient_scope", DELETE_SCOPE_MESSAGE);
  if (!ctx.limiters.tokenWrite.consume(`token:${ctx.userId}`)) return toolError("too_many_requests", RATE_LIMITED_MESSAGE);
  return null;
}
