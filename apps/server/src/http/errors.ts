import type { FastifyReply } from "fastify";
import type { ErrorCode, StorageQuotaErrorDetail } from "@knotebook/shared";
import { noteTooLargeMessage } from "../notes/note-size.js";
import { STORAGE_QUOTA_EXCEEDED_MESSAGE } from "../storage/space.js";

/** Route `bodyLimit`s differ, so the message carries no number. */
export const BODY_TOO_LARGE_MESSAGE = "The request body is over this endpoint's size limit. Send a smaller request.";

export function sendError(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}

export function sendNoteTooLarge(reply: FastifyReply, limitBytes: number): FastifyReply {
  return reply.code(413).send({ error: { code: "note_too_large", message: noteTooLargeMessage(limitBytes), limitBytes } });
}

export function sendLoginThrottled(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply.code(429).send({
    error: { code: "too_many_attempts", message: "Too many sign-in attempts. Wait a moment and try again." },
    retryAfterMs,
  });
}

/**
 * The two upload 409s (pre-check before reading the body, check in the transaction) must stay indistinguishable (#200): never add a flag field.
 * The message is the shared STORAGE_QUOTA_EXCEEDED_MESSAGE so the pre-check (which has no exception object) and the in-transaction check emit
 * the same sentence; detail's number visibility is decided by the caller outside the transaction (quotaErrorDetail).
 */
export function sendStorageQuotaExceeded(reply: FastifyReply, detail: StorageQuotaErrorDetail): FastifyReply {
  return reply.code(409).send({ error: { code: "storage_quota_exceeded", message: STORAGE_QUOTA_EXCEEDED_MESSAGE }, storage: detail });
}

/** Only for callers with trash access; everyone else must get the plain not_found so existence doesn't leak. */
export function sendInTrash(reply: FastifyReply, noteId: string): FastifyReply {
  return reply.code(404).send({ error: { code: "in_trash", message: "This note is in the trash." }, noteId });
}
