import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq, and, sql } from "drizzle-orm";
import { SESSION_COOKIE, SITE_LIMITS, type UserAvatarDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sessions, userAvatars, users } from "../db/schema.js";
import { BoundedMap } from "../lib/bounded-map.js";

// Default only: each issuance reads the live `sessionTtlSeconds` limit and passes that one value to `signSession`, `setSessionCookie` and `newSessionValues`.
export const SESSION_TTL_SECONDS = SITE_LIMITS.sessionTtlSeconds.default;

function sessionKey(secret: string): Uint8Array {
  return createHash("sha256").update(`${secret}:session`).digest();
}

/** `sessions.id` is a uuid column: a non-uuid sid would hit 22P02 (500) in the query, so reject it at verify. Shared with collab tokens. */
export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Callers create the `sessions` row first; `ttlSeconds` must equal the row's and the cookie's TTL, or the row expires first and the user is logged out early. */
export async function signSession(secret: string, payload: { userId: string; tv: number; sid: string }, ttlSeconds: number): Promise<string> {
  const key = sessionKey(secret);
  return new SignJWT({ tv: payload.tv, sid: payload.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifySession(secret: string, jwt: string): Promise<{ userId: string; tv: number; sid: string } | null> {
  try {
    const key = sessionKey(secret);
    const { payload } = await jwtVerify(jwt, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.tv !== "number") return null;
    // Pre-upgrade JWTs have no sid: there is no row to delete, so logout could not revoke them.
    if (typeof payload.sid !== "string" || !SID_RE.test(payload.sid)) return null;
    return { userId: payload.sub, tv: payload.tv, sid: payload.sid };
  } catch {
    return null;
  }
}

export interface GateUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  autoVersions: boolean;
  /** Writers of the avatar must call `invalidate`. */
  avatar: UserAvatarDto | null;
}

export type GateResult = { status: "ok"; user: GateUser } | { status: "revoked" };

export interface GateRow {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  tokenVersion: number;
  mustChangePassword: boolean;
  hasPassword: boolean;
  autoVersions: boolean;
  avatar: UserAvatarDto | null;
}

interface CacheEntry {
  row: GateRow | null;
  expiresAt: number;
}

export interface SessionRow {
  userId: string;
  expiresAt: Date;
}

interface SessionCacheEntry {
  row: SessionRow | null;
  expiresAt: number;
}

export interface UserGateOptions {
  maxEntries?: number;
  now?: () => number;
  /** Tests only (e.g. inject delay to reproduce the invalidate race); production must not pass it. */
  fetchRow?: (userId: string) => Promise<GateRow | null>;
  /** Tests only, like `fetchRow`. */
  fetchSession?: (sessionId: string) => Promise<SessionRow | null>;
}

const DEFAULT_MAX_ENTRIES = 1000;
const CACHE_TTL_MS = 60_000;

/**
  * Caches DB row snapshots, not verdicts (the verdict depends on the caller's `tv`). `invalidate()` is the revocation
  * path, the 60s TTL a backstop. A generation counter stops a fetch in flight during `invalidate()` from caching its stale
  * row. Sessions work the same way (`sessionGen`); `expires_at` is compared to now on every check, so the cache never extends a
  * session. Logout must call `invalidateSession` AFTER the DELETE, or a `check` in between recaches the row. Caches are per
  * process (single-instance deployment): another process sees a logout up to 60s late.
  */
export class UserGate {
  private readonly cache: BoundedMap<CacheEntry>;
  private readonly sessionCache: BoundedMap<SessionCacheEntry>;
  private readonly now: () => number;
  private readonly fetchRow: (userId: string) => Promise<GateRow | null>;
  private readonly fetchSession: (sessionId: string) => Promise<SessionRow | null>;
  private gen = 0;
  private sessionGen = 0;

  constructor(
    private readonly db: Db,
    options: UserGateOptions = {}
  ) {
    this.cache = new BoundedMap<CacheEntry>(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.sessionCache = new BoundedMap<SessionCacheEntry>(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.fetchRow = options.fetchRow ?? (userId => this.fetchRowFromDb(userId));
    this.fetchSession = options.fetchSession ?? (sessionId => this.fetchSessionFromDb(sessionId));
  }

  async check(userId: string, tv: number, sessionId: string): Promise<GateResult> {
    const row = await this.getRow(userId);
    const result = UserGate.evaluate(row, tv);
    if (result.status !== "ok") return result;
    const session = await this.getSession(sessionId);
    if (!session || session.userId !== userId || session.expiresAt.getTime() <= this.now()) return { status: "revoked" };
    return result;
  }

    /** Bearer path: same `getRow` as `check()` but ignores tokenVersion (a password change doesn't revoke API tokens; revoke per token or by admin disable). Don't fetch separately: the `gen` guard is what stops a disabled user's token working for up to 60s. */
  async checkUser(userId: string): Promise<GateResult> {
    const row = await this.getRow(userId);
    return UserGate.evaluate(row, row?.tokenVersion ?? 0);
  }

  private async getRow(userId: string): Promise<GateRow | null> {
    let entry = this.cache.get(userId);
    if (!entry || entry.expiresAt <= this.now()) {
      const g = this.gen;
      const row = await this.fetchRow(userId);
      entry = { row, expiresAt: this.now() + CACHE_TTL_MS };
      if (g === this.gen) this.store(userId, entry);
    }
    return entry.row;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.gen++;
  }

  invalidateSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.sessionGen++;
  }

  private async getSession(sessionId: string): Promise<SessionRow | null> {
    let entry = this.sessionCache.get(sessionId);
    if (!entry || entry.expiresAt <= this.now()) {
      const g = this.sessionGen;
      const row = await this.fetchSession(sessionId);
      entry = { row, expiresAt: this.now() + CACHE_TTL_MS };
      if (g === this.sessionGen) this.sessionCache.set(sessionId, entry);
    }
    return entry.row;
  }

  private async fetchSessionFromDb(sessionId: string): Promise<SessionRow | null> {
    const [row] = await this.db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row ?? null;
  }

  private async fetchRowFromDb(userId: string): Promise<GateRow | null> {
    // At most one `is_current` row per user (partial unique index), so the LEFT JOIN can't duplicate user rows.
    const rows = await this.db
      .select({
        user: users,
        avatarId: userAvatars.id,
        avatarVersion: userAvatars.version,
        avatarPending: sql<boolean | null>`${userAvatars.displayData} is null`,
      })
      .from(users)
      .leftJoin(userAvatars, and(eq(userAvatars.userId, users.id), eq(userAvatars.isCurrent, true)))
      .where(eq(users.id, userId))
      .limit(1);
    const found = rows[0];
    if (!found) return null;
    const row = found.user;
    return {
      id: row.id,
      email: row.email,
      handle: row.handle,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      disabledAt: row.disabledAt,
      tokenVersion: row.tokenVersion,
      mustChangePassword: row.mustChangePassword,
      hasPassword: row.passwordHash !== null,
      autoVersions: row.autoVersions,
      avatar: found.avatarId === null ? null : { id: found.avatarId, v: found.avatarVersion!, pending: found.avatarPending === true },
    };
  }

  private store(userId: string, entry: CacheEntry): void {
    // Hits don't reorder: eviction is by insertion order, not strict LRU.
    this.cache.set(userId, entry);
  }

  private static evaluate(row: GateRow | null, tv: number): GateResult {
    if (!row || row.disabledAt !== null || row.tokenVersion !== tv) {
      return { status: "revoked" };
    }
    return {
      status: "ok",
      user: {
        id: row.id,
        email: row.email,
        handle: row.handle,
        displayName: row.displayName,
        isAdmin: row.isAdmin,
        mustChangePassword: row.mustChangePassword,
        hasPassword: row.hasPassword,
        autoVersions: row.autoVersions,
        avatar: row.avatar,
      },
    };
  }
}

/** Not a preHandler: the manual-link callback must always 302, so it borrows only this core. */
export async function resolveSessionUser(
  cookies: Record<string, string | undefined>,
  appSecret: string,
  gate: UserGate,
): Promise<ResolvedSession | null> {
  const token = cookies[SESSION_COOKIE];
  const session = token ? await verifySession(appSecret, token) : null;
  if (!session) return null;
  const result = await gate.check(session.userId, session.tv, session.sid);
  if (result.status !== "ok") return null;
  return { user: result.user, tv: session.tv, sid: session.sid };
}

export interface ResolvedSession {
  user: GateUser;
  tv: number;
  sid: string;
}
