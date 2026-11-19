import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { COLLAB_TOKEN_TTL_SECONDS, type CollabTokenClaims, type Role } from "@knotebook/shared";
import { SID_RE } from "../auth/session.js";

const COLLAB_TOKEN_TTL = `${COLLAB_TOKEN_TTL_SECONDS}s`;

const ROLES: readonly Role[] = ["owner", "editor", "viewer", "none"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// Distinct ":collab" suffix, so session tokens and collab tokens can't verify as each other.
function collabKey(secret: string): Uint8Array {
  return createHash("sha256").update(`${secret}:collab`).digest();
}

/** `role: "none"` is valid: the collab-token endpoint answers 200 with such a token to users without access. */
export async function signCollabToken(appSecret: string, claims: CollabTokenClaims): Promise<string> {
  const key = collabKey(appSecret);
  return new SignJWT({ noteId: claims.noteId, role: claims.role, tv: claims.tv, sid: claims.sid, sv: claims.sv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(COLLAB_TOKEN_TTL)
    .sign(key);
}

/** Returns null instead of throwing on any invalid token, like `verifySession`. */
export async function verifyCollabToken(appSecret: string, token: string): Promise<CollabTokenClaims | null> {
  try {
    const key = collabKey(appSecret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    if (typeof payload.noteId !== "string") return null;
    if (typeof payload.tv !== "number") return null;
    // #388: reject tokens without a uuid sid; the old session cookie behind them has no sid either, so the refetch 401s into login.
    if (typeof payload.sid !== "string" || !SID_RE.test(payload.sid)) return null;
    if (!isRole(payload.role)) return null;
    // #269: a missing `sv` is not a bad token; as 0 it gets rejected by onAuthenticate as client-outdated.
    const sv = typeof payload.sv === "number" && Number.isInteger(payload.sv) ? payload.sv : 0;
    return { userId: payload.sub, noteId: payload.noteId, role: payload.role, tv: payload.tv, sid: payload.sid, sv };
  } catch {
    return null;
  }
}

/** #269: bad input means 0, not a 400: the endpoint answers 200 to everyone and onAuthenticate rejects the mismatch. */
export function schemaVersionFromBody(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const value = (body as { noteSchemaVersion?: unknown }).noteSchemaVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
