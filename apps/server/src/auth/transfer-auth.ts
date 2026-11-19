import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { hasScope, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, transferTokens } from "../db/schema.js";
import { drainWithCap } from "../http/drain.js";
import { sendError } from "../http/errors.js";
import { retryAfterSeconds, type FixedWindowLimiter } from "../http/rate-limit.js";
import { hashToken, isAccessTokenShape, parseAuthorizationHeader } from "./api-token.js";
import { buildTransferChallenge } from "./challenge.js";
import type { UserGate } from "./session.js";
import { isTransferTokenShape, type BulkAccess, type BulkRange, type TransferPurpose } from "./transfer-token.js";

/** Same text for every invalid case, so the response doesn't leak which one it was (timing side channel). */
export const TRANSFER_INVALID_MESSAGE = "The transfer token is invalid, expired or already used.";
export const TRANSFER_PAT_MESSAGE = "This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_transfer_token.";
export const BULK_TRANSFER_PAT_MESSAGE = "This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool open_notes_as_files.";
export const BULK_TRANSFER_REQUIRED_MESSAGE = "A transfer token is required.";
/** Omits "already used": bulk tokens are reusable until expiry. */
export const BULK_TRANSFER_INVALID_MESSAGE = "The transfer token is invalid, expired or revoked. Get a new one from the MCP tool open_notes_as_files.";
export const TRANSFER_PURPOSE_MESSAGE = "This transfer token can't be used for this action.";

export interface TransferAuthDeps {
  db: Db;
  gate: UserGate;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  limiters: { bearerMiss: FixedWindowLimiter };
}

/**
  * With a header only the transfer path applies (no cookie fallback); plain PATs/OAuth tokens get a dedicated 401 message. Expiry (child
  * and parent) is judged with DB `now()`, the POST's clock. Early returns drain the body first (else the client gets a network error).
  * Every 401 for a request with a header consumes `bearerMiss` (full bucket: 429 with Retry-After and no WWW-Authenticate); the
  * header-less 401 comes from `app.authenticate` and doesn't, and 403 doesn't. `request.tokenId` is the parent's id (so the error log shows
  * which one); the parent's `last_used_at` isn't updated. Headers are set before `sendError`.
  */
export function createTransferAuth(deps: TransferAuthDeps) {
  function reject401(request: FastifyRequest, reply: FastifyReply, withError: boolean, message: string): void {
    drainWithCap(request);
    if (!deps.limiters.bearerMiss.consume(request.ip)) {
      reply.header("retry-after", String(retryAfterSeconds(deps.limiters.bearerMiss.retryAfterMs(request.ip))));
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      return;
    }
    reply.header("www-authenticate", buildTransferChallenge(withError ? "invalid_token" : undefined));
    sendError(reply, 401, "unauthorized", message);
  }

  function rejectInvalid(request: FastifyRequest, reply: FastifyReply): void {
    reject401(request, reply, true, TRANSFER_INVALID_MESSAGE);
  }

  function rejectInvalidBulk(request: FastifyRequest, reply: FastifyReply): void {
    reject401(request, reply, true, BULK_TRANSFER_INVALID_MESSAGE);
  }

  function require(purpose: TransferPurpose) {
    return async function transferPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const raw = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(raw);

      if (parsed.kind === "none") {
        await deps.authenticate(request, reply);
        if (!reply.sent) request.authKind = "session";
        return;
      }
      if (parsed.kind === "other-scheme") return reject401(request, reply, false, "Not signed in.");
      if (isAccessTokenShape(parsed.token)) return reject401(request, reply, true, TRANSFER_PAT_MESSAGE);
      if (!isTransferTokenShape(parsed.token)) return rejectInvalid(request, reply);

      const [row] = await deps.db
        .select({
          id: transferTokens.id,
          noteId: transferTokens.noteId,
          purpose: transferTokens.purpose,
          consumedAt: transferTokens.consumedAt,
          parentId: apiTokens.id,
          userId: apiTokens.userId,
          scope: apiTokens.scope,
        })
        .from(transferTokens)
        .innerJoin(apiTokens, eq(apiTokens.id, transferTokens.parentTokenId))
        .where(
          and(
            eq(transferTokens.tokenHash, hashToken(parsed.token)),
            sql`${transferTokens.expiresAt} > now()`,
            sql`(${apiTokens.accessExpiresAt} is null or ${apiTokens.accessExpiresAt} > now())`
          )
        )
        .limit(1);
      if (row === undefined) return rejectInvalid(request, reply);
      // Fast path only: the real one-shot guard is the POST's atomic consume (routes/uploads.ts).
      if (row.purpose === "upload" && row.consumedAt !== null) return rejectInvalid(request, reply);

      if (row.purpose !== purpose) {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", TRANSFER_PURPOSE_MESSAGE);
        return;
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok" || gateResult.user.mustChangePassword) return rejectInvalid(request, reply);

      // Reachable: the parent can be downgraded in place (PATCH), so scope is re-checked on every use. No `insufficient_scope` challenge: there is no scope to request.
      if (!hasScope(row.scope as TokenScope, purpose === "upload" ? "notes:write" : "notes:read")) {
        drainWithCap(request);
        sendError(reply, 403, "insufficient_scope", "This token's scope doesn't allow this action.");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "transfer";
      // CHECK `transfer_tokens_bulk_note_chk`: purpose != bulk implies note_id is set, and bulk rows got a 403 above.
      request.transfer = { id: row.id, noteId: row.noteId!, purpose, parentTokenId: row.parentId };
      request.tokenId = row.parentId;
    };
  }

    /**
     * Not shared with `require()`: with no header it is a plain 401 (no cookie fallback, `bearerMiss` not consumed); a header 401 consumes it
     * (429 with Retry-After when full). `purpose != 'bulk'` gives 403 forbidden. `write` also needs the token's own `access = 'write'` and the
     * parent's current `notes:write`, else 403 `insufficient_scope` (the code `require()` and `bearer.ts` use; `forbidden` is only for a
     * purpose mismatch), without WWW-Authenticate. Both scope checks come after the user gate (a disabled read-only token gets 401, not 403).
     */
  function requireBulk(op: "read" | "write") {
    const needed = op === "read" ? "notes:read" : "notes:write";
    return async function bulkPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const raw = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(raw);
      if (parsed.kind === "none") {
        drainWithCap(request);
        reply.header("www-authenticate", buildTransferChallenge());
        sendError(reply, 401, "unauthorized", BULK_TRANSFER_REQUIRED_MESSAGE);
        return;
      }
      if (parsed.kind === "other-scheme") return reject401(request, reply, false, "Not signed in.");
      if (isAccessTokenShape(parsed.token)) return reject401(request, reply, true, BULK_TRANSFER_PAT_MESSAGE);
      if (!isTransferTokenShape(parsed.token)) return rejectInvalidBulk(request, reply);

      const [row] = await deps.db
        .select({
          id: transferTokens.id,
          purpose: transferTokens.purpose,
          access: transferTokens.access,
          range: transferTokens.range,
          parentId: apiTokens.id,
          userId: apiTokens.userId,
          scope: apiTokens.scope,
        })
        .from(transferTokens)
        .innerJoin(apiTokens, eq(apiTokens.id, transferTokens.parentTokenId))
        .where(
          and(
            eq(transferTokens.tokenHash, hashToken(parsed.token)),
            sql`${transferTokens.expiresAt} > now()`,
            sql`(${apiTokens.accessExpiresAt} is null or ${apiTokens.accessExpiresAt} > now())`
          )
        )
        .limit(1);
      if (row === undefined) return rejectInvalidBulk(request, reply);
      if (row.purpose !== "bulk") {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", TRANSFER_PURPOSE_MESSAGE);
        return;
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok" || gateResult.user.mustChangePassword) return rejectInvalidBulk(request, reply);

      // read is practically unreachable (every scope includes notes:read); write is reachable since the parent can be downgraded, and needs the token's own `access = 'write'`.
      if ((op === "write" && row.access !== "write") || !hasScope(row.scope as TokenScope, needed)) {
        drainWithCap(request);
        sendError(reply, 403, "insufficient_scope", "This token's scope doesn't allow this action.");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "transfer";
      // CHECKs `transfer_tokens_bulk_access_chk` and `_bulk_range_chk` make both columns non-null on bulk rows, which the casts rely on.
      request.bulkTransfer = { id: row.id, parentTokenId: row.parentId, access: row.access as BulkAccess, range: row.range as BulkRange };
      request.tokenId = row.parentId;
    };
  }

  return { require, requireBulk, rejectInvalid };
}
