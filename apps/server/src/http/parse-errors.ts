import type { FastifyReply } from "fastify";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { NoteReadTooComplexError } from "../notes/editing/read.js";
import { sendError } from "./errors.js";

export const PARSER_BUSY_RETRY_AFTER_S = 5;
export const PARSER_BUSY_MESSAGE = "The server is busy processing other writes. Try again in a moment.";
export const READ_BUSY_MESSAGE = "The server is busy processing other requests. Try again in a moment.";
export const NOTE_WRITE_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to change within the server's time and memory limits, so nothing was written. Retrying won't help; split the note to keep editing it this way.";
export const READ_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to read within the server's time and memory limits.";

export const TOO_COMPLEX_MESSAGE =
  "The content is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller parts or simplify its formatting.";

export function sendParserBusy(reply: FastifyReply, message = PARSER_BUSY_MESSAGE): FastifyReply {
  reply.header("retry-after", String(PARSER_BUSY_RETRY_AFTER_S));
  return sendError(reply, 503, "server_busy", message);
}

export function sendDocReadError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ParserBusyError) return sendParserBusy(reply, READ_BUSY_MESSAGE);
  if (err instanceof NoteReadTooComplexError) return sendError(reply, 500, "too_complex", READ_TOO_COMPLEX_MESSAGE);
  return null;
}
