/**
 * Lowercases UUID path params (#240): live doc, presence and the write queue are keyed by string and only know lowercase, while the uuid column
 * is case-insensitive, so an uppercase id would find the row but hit separate in-memory state. Only id/userId; non-UUID values (each route's
 * own 404) and other params (:ref, :handle, :slug, :editId, :groupId…) are untouched.
 */
import type { FastifyRequest } from "fastify";
import { UUID_RE } from "../notes/service.js";

export const LOWERCASED_PARAMS = ["id", "userId"] as const;

export async function lowercaseUuidParams(request: FastifyRequest): Promise<void> {
  const params = request.params as Record<string, unknown> | undefined;
  if (!params) return;
  for (const key of LOWERCASED_PARAMS) {
    const value = params[key];
    if (typeof value === "string" && UUID_RE.test(value)) params[key] = value.toLowerCase();
  }
}
