import type { FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http/errors.js";
import { MAX_ISSUER_LENGTH } from "./oidc-client.js";

// Mirrors the CHECKs of migration 0014 so zod rejects first (a value zod accepts but the CHECK rejects is a 500, not a 400).
// issuer: the scheme test is case-sensitive like the CHECK and the env import (`new URL` lowercases the scheme, so it can't be used);
// length <= 512 uses JS `.length` (UTF-16), which is >= the code-point count, so it is only stricter.
// Display name (1..40) and client id (1..512) count code points (`[...s].length`; `.length` counts an emoji as 2).
// NUL and lone surrogates are rejected too (22021 in text columns). Strings are trimmed before validating and storing.

const UNSTORABLE = /[\0]|\p{Surrogate}/u;
const ISSUER_SCHEME = /^https?:\/\//;
const codePoints = (s: string): number => [...s].length;
/** NUL and lone surrogates in a PG text column give 22021/22P05 (a 500). Registration display names use this too. */
export function isStorableText(s: string): boolean {
  return !UNSTORABLE.test(s);
}
const storable = isStorableText;
const UNSTORABLE_MESSAGE = "contains characters that can't be stored.";

export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_CLIENT_ID_LENGTH = 512;
/** Fits any real client secret; stops stuffing garbage into the jsonb. */
export const MAX_CLIENT_SECRET_LENGTH = 4096;

const displayName = z
  .string()
  .trim()
  .refine(storable, `The display name ${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_DISPLAY_NAME_LENGTH, `The display name must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`);

export const issuerUrlSchema = z
  .string()
  .trim()
  .refine(storable, `The issuer URL ${UNSTORABLE_MESSAGE}`)
  .refine(s => ISSUER_SCHEME.test(s), "The issuer URL must start with lowercase http:// or https://.")
  .refine(s => s.length <= MAX_ISSUER_LENGTH, `The issuer URL can be at most ${MAX_ISSUER_LENGTH} characters.`)
  .refine(s => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }, "The issuer is not a valid URL.")
  // No credentials: the issuer is a plaintext field (DB, returned verbatim by GET, logged) and fetch refuses such URLs anyway.
  // zod's refine chain doesn't short-circuit, so a parse failure passes here (the check above reports it).
  .refine(s => {
    try {
      const u = new URL(s);
      return u.username === "" && u.password === "";
    } catch {
      return true;
    }
  }, "The issuer URL can't contain a username or password.");

const clientId = z
  .string()
  .trim()
  .refine(storable, `The client ID ${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_CLIENT_ID_LENGTH, `The client ID must be 1 to ${MAX_CLIENT_ID_LENGTH} characters.`);

/** Not trimmed (sent to the IdP verbatim); only all-whitespace and over-long values are rejected. */
const clientSecret = z
  .string()
  .refine(storable, `The client secret ${UNSTORABLE_MESSAGE}`)
  .refine(s => s.trim().length > 0, "The client secret can't be empty (there's no API to clear it).")
  .refine(s => s.length <= MAX_CLIENT_SECRET_LENGTH, `The client secret can be at most ${MAX_CLIENT_SECRET_LENGTH} characters.`);

// `autoCreateEnabled` isn't accepted on create (strict schema: 400); new providers always start with it off.
export const createProviderSchema = z
  .object({
    template: z.enum(["gitlab", "google", "oidc"]),
    displayName,
    issuerUrl: issuerUrlSchema,
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
  })
  .strict();

/** Omitted fields mean unchanged (SQL coalesces to the current value). `template` and `legacyCallback` can't be changed. */
export const patchProviderSchema = z
  .object({
    displayName: displayName.optional(),
    issuerUrl: issuerUrlSchema.optional(),
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
    enabled: z.boolean().optional(),
    autoCreateEnabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    // `upload` is only possible via PUT .../icon, not here; the values must equal CHECK `auth_providers_icon_kind_chk` minus upload.
    iconKind: z.enum(["template", "gitlab", "google", "none"]).optional(),
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, "Invalid request body: send at least one field.");

export const discoverSchema = z.object({ issuerUrl: issuerUrlSchema }).strict();

/** zod's built-in messages are too technical, so only custom (refine) messages pass through. */
export function sendInvalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const custom = error.issues.find(issue => issue.code === "custom");
  return sendError(reply, 400, "invalid_body", custom?.message ?? "Invalid request body.");
}
