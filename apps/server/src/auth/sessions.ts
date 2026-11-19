import { and, eq, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { SiteLimits } from "../site-limits/store.js";
import { setSessionCookie } from "./cookies.js";
import { signSession, verifySession, type UserGate } from "./session.js";
import { newSessionValues } from "./tx/sessions.js";

// Issue login cookies only through here: the `sessions` row must exist. The tv bump + `gate.invalidate` is what kicks other devices out; deleting rows leaves those JWTs without a row.

export interface SessionDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  siteLimits: SiteLimits;
}

/** Long enough for the browser to store the new cookie; plus `COLLAB_REVERIFY_DEADLINE_MS` it bounds how long a copied old cookie's connection survives. */
export const RELOGIN_REVERIFY_DELAY_MS = 10_000;

export interface StartSessionDeps extends SessionDeps {
  collabHooks: CollabHooks;
  reloginReverifyDelayMs?: number;
}

export async function insertSession(db: Db, userId: string, ttlSeconds: number): Promise<string> {
  const [row] = await db.insert(sessions).values(newSessionValues(userId, ttlSeconds)).returning({ id: sessions.id });
  return row!.id;
}

export async function setSessionCookieFor(
  reply: FastifyReply,
  config: AppConfig,
  session: { userId: string; tv: number; sid: string; ttlSeconds: number },
): Promise<void> {
  const { ttlSeconds, ...payload } = session;
  const jwt = await signSession(config.appSecret, payload, ttlSeconds);
  setSessionCookie(reply, config, jwt, ttlSeconds);
}

/**
  * Returns the deleted row, or null when there is nothing to revoke. Only the cookie's signature is checked (not tv, disabled or
  * expiry). Whether to re-verify collab connections is the caller's call (logout does, login doesn't). Never throws: a DB error
  * is logged and the row lives until it expires (the cache is left alone). DELETE first, then `invalidateSession`: reversed, a
  * `check` in between recaches the row.
  */
export async function deleteSessionFromCookie(
  deps: SessionDeps,
  request: FastifyRequest,
  onlyUserId?: string,
): Promise<{ userId: string; sid: string } | null> {
  const token = request.cookies[SESSION_COOKIE];
  const session = token ? await verifySession(deps.config.appSecret, token) : null;
  if (!session) return null;
  if (onlyUserId !== undefined && session.userId !== onlyUserId) return null;
  let deleted: Array<{ id: string }>;
  try {
    // `userId` is matched too as defence in depth (the signature is already verified).
    deleted = await deps.db
      .delete(sessions)
      .where(and(eq(sessions.id, session.sid), eq(sessions.userId, session.userId)))
      .returning({ id: sessions.id });
  } catch (err) {
    request.log.error({ err, userId: session.userId }, "failed to delete session row");
    return null;
  }
  if (deleted.length === 0) return null;
  deps.gate.invalidateSession(session.sid);
  return { userId: session.userId, sid: session.sid };
}

/**
  * Only the SAME account's previous cookie is invalidated (another account's session on this browser keeps its row; its cookie is just
  * overwritten). Expired rows are cleaned opportunistically, fire-and-forget (no scheduler). Unlike logout, collab connections of the
  * replaced sid are re-verified after `RELOGIN_REVERIFY_DELAY_MS`: an immediate re-verify could make the old tab fetch a token before
  * the browser stored the new cookie (401, login redirect); after the delay the old tab gets a token for the new sid and stays, while
  * a copied old cookie's connection closes within about 10 s plus the 5 s re-verify deadline. Without it there is no bound: the
  * collab token TTL is only checked at handshake and re-verification. The timer is `unref()`ed so it doesn't hold up shutdown
  * (firing during shutdown is safe: hooks don't throw).
  */
export async function startSession(
  deps: StartSessionDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  user: { userId: string; tv: number },
): Promise<void> {
  // Read once so row, JWT and cookie agree even if an admin changes the setting mid-issue.
  const ttlSeconds = deps.siteLimits.get("sessionTtlSeconds");
  const replaced = await deleteSessionFromCookie(deps, request, user.userId);
  if (replaced) {
    const timer = setTimeout(() => deps.collabHooks.onSessionRevoked(replaced.userId, replaced.sid), deps.reloginReverifyDelayMs ?? RELOGIN_REVERIFY_DELAY_MS);
    timer.unref();
  }
  const sid = await insertSession(deps.db, user.userId, ttlSeconds);
  await setSessionCookieFor(reply, deps.config, { ...user, sid, ttlSeconds });
  void deleteExpiredSessions(deps.db).catch((err: unknown) => {
    request.log.warn({ err }, "failed to delete expired sessions");
  });
}

const EXPIRED_SESSION_BATCH = 1000;

/** `for update skip locked` is load-bearing: row replacement, disable and user-delete cascades may lock the same rows. Batched because it runs un-awaited after login. */
export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${sessions} where ${sessions.id} in (select ${sessions.id} from ${sessions} where ${sessions.expiresAt} < now() limit ${EXPIRED_SESSION_BATCH} for update skip locked)`,
  );
}
