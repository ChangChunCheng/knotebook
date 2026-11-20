import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb, testSessionId } from "./helpers.js";
import { UserGate, type GateRow } from "../src/auth/session.js";
import { sessions, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    passwordHash: string | null;
  }> = {}
) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash: overrides.passwordHash ?? null,
    })
    .returning();
  return u;
}

describe("UserGate", () => {
  it("check ok: returns the full user object (including isAdmin)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { isAdmin: true, tokenVersion: 3 });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 3, testSessionId(u.id));
    expect(result).toEqual({
      status: "ok",
      user: { id: u.id, email: u.email, handle: u.handle, displayName: u.displayName, isAdmin: true, mustChangePassword: false, hasPassword: false, autoVersions: true, avatar: null },
    });
  });

  it("hasPassword: OIDC-only (no passwordHash) -> false (projected via fetchRowFromDb on a real DB)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, passwordHash: null });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 0, testSessionId(u.id));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.user.hasPassword).toBe(false);
    }
  });

  it("hasPassword: with passwordHash -> true (projected via fetchRowFromDb on a real DB)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, passwordHash: "some-argon2-hash" });
    const gate = new UserGate(db);
    const result = await gate.check(u.id, 0, testSessionId(u.id));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.user.hasPassword).toBe(true);
    }
  });

  it("tv mismatch -> revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);
    expect(await gate.check(u.id, 2, testSessionId(u.id))).toEqual({ status: "revoked" });
  });

  it("disabledAt set -> revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0, disabledAt: new Date() });
    const gate = new UserGate(db);
    expect(await gate.check(u.id, 0, testSessionId(u.id))).toEqual({ status: "revoked" });
  });

  it("user doesn't exist -> revoked", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    expect(await gate.check("00000000-0000-0000-0000-000000000000", 0, testSessionId("00000000-0000-0000-0000-000000000000"))).toEqual({ status: "revoked" });
  });

  it("a cache hit still compares tv (within the same cache window, a mismatching tv must still give revoked)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);

    expect((await gate.check(u.id, 3, testSessionId(u.id))).status).toBe("ok"); // builds the cache (row.tokenVersion=3)
    expect((await gate.check(u.id, 2, testSessionId(u.id))).status).toBe("revoked"); // cache hit, but the passed tv doesn't match, still revoked
  });

  it("cache behaviour: after check ok, changing the DB tv directly is still ok (cache hit); after invalidate the DB is re-read -> revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });
    const gate = new UserGate(db);

    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok"); // cache hit, DB not re-read

    gate.invalidate(u.id);
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("revoked"); // DB re-read after invalidate
  });

  it("DB re-read after the TTL expires", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });
    let now = 1_000_000;
    const gate = new UserGate(db, { now: () => now });

    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok"); // TTL not yet passed, cache hit

    now += 61_000; // advance 61s, past the 60s TTL
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("revoked"); // TTL expired, DB re-read
  });

  it("LRU limit: once full the oldest is evicted, and checking it again re-reads the DB", async () => {
    const { db } = await freshDb();
    const u1 = await insertUser(db, { tokenVersion: 0 });
    const u2 = await insertUser(db, { tokenVersion: 0 });
    const u3 = await insertUser(db, { tokenVersion: 0 });
    const gate = new UserGate(db, { maxEntries: 2 });

    expect((await gate.check(u1.id, 0, testSessionId(u1.id))).status).toBe("ok"); // cache: [u1]
    expect((await gate.check(u2.id, 0, testSessionId(u2.id))).status).toBe("ok"); // cache: [u1, u2]

    // Bypass the gate and change the DB directly: if u1 were still cached, a later check wouldn't see this change
    await db.update(users).set({ tokenVersion: 99 }).where(eq(users.id, u1.id));

    expect((await gate.check(u3.id, 0, testSessionId(u3.id))).status).toBe("ok"); // cache full, the oldest u1 is evicted -> cache: [u2, u3]

    // Verify that only the oldest u1 was evicted and u2 is still cached - guards against the wrong implementation "clear everything when full".
    // Bypass the gate and change u2's DB row directly; if u2 is really still cached (correct), check should return the old snapshot in cache
    // (ok, still tv=0) and not see this change; if check reads the new value (tokenVersion=55, mismatching the passed tv=0 -> revoked),
    // u2 was evicted by mistake. Note: this assertion must come before "check u1" - with maxEntries=2 the cache stays full after eviction
    // ([u2, u3]); checking u1 first (cache miss, the store triggers another eviction) would push u2 out of the cache too and make this check meaningless.
    await db.update(users).set({ tokenVersion: 55 }).where(eq(users.id, u2.id));
    expect((await gate.check(u2.id, 0, testSessionId(u2.id))).status).toBe("ok");

    // u1 was evicted; the re-read should see tokenVersion=99, mismatching the passed tv=0 -> revoked
    expect((await gate.check(u1.id, 0, testSessionId(u1.id))).status).toEqual("revoked");
  });

  it("invalidate vs in-flight fetch race: invalidated while the query is in flight, the finished old result isn't cached", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 0 });

    let firstFetchStarted = false;
    let resolveSlowFetch!: (row: GateRow | null) => void;
    const slowFetch = new Promise<GateRow | null>(resolve => {
      resolveSlowFetch = resolve;
    });

    let callCount = 0;
    const gate = new UserGate(db, {
      fetchRow: async userId => {
        callCount++;
        if (callCount === 1) {
          firstFetchStarted = true;
          return slowFetch; // stays stuck until the test resolves it by hand, simulating the "query in flight" window
        }
        // From the second call on, query the real DB as usual (simulates the next check after invalidate)
        const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const row = rows[0];
        return row
          ? {
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
              avatar: null,
            }
          : null;
      },
    });

    const firstCheck = gate.check(u.id, 0, testSessionId(u.id)); // triggers the first (stuck) query
    expect(firstFetchStarted).toBe(true);

    // At this point the cache has no entry for u (the first query hasn't returned) - invalidate's cache.delete is a no-op,
    // but gen is incremented; that is exactly the race window being protected.
    gate.invalidate(u.id);

    // Let the stuck first query finish, returning the old data read "before the revocation"
    resolveSlowFetch({
      id: u.id,
      email: u.email,
      handle: u.handle,
      displayName: u.displayName,
      isAdmin: false,
      disabledAt: null,
      tokenVersion: 0,
      mustChangePassword: false,
      hasPassword: false,
      autoVersions: true,
      avatar: null,
    });
    const first = await firstCheck;
    expect(first.status).toBe("ok"); // this call itself still answers correctly with the data it read

    // Key assertion: without the generation guard, the result of that "old fetch" would be written to the cache with a 60s TTL, silently overriding the invalidate.
    // After a real revocation (tokenVersion changed), the next check must re-read the DB.
    await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, u.id));
    const second = await gate.check(u.id, 0, testSessionId(u.id));
    expect(second.status).toBe("revoked");
  });
});

describe("UserGate.checkUser (#107: user-status gate of the token path)", () => {
  it("a tokenVersion change has no effect (a password change doesn't invalidate API tokens)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { tokenVersion: 3 });
    const gate = new UserGate(db);

    expect((await gate.checkUser(u.id)).status).toBe("ok");

    await db.update(users).set({ tokenVersion: 4 }).where(eq(users.id, u.id));
    gate.invalidate(u.id);

    // The session path (check) is rejected with the old tv; the token path (checkUser) is unaffected.
    expect((await gate.check(u.id, 3, testSessionId(u.id))).status).toBe("revoked");
    expect((await gate.checkUser(u.id)).status).toBe("ok");
  });

  it("checkUser returns a user of the same shape as check (the same evaluate projection)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db, { isAdmin: true, passwordHash: "some-argon2-hash" });
    const gate = new UserGate(db);
    const result = await gate.checkUser(u.id);
    expect(result).toEqual({
      status: "ok",
      user: {
        id: u.id,
        email: u.email,
        handle: u.handle,
        displayName: u.displayName,
        isAdmin: true,
        mustChangePassword: false,
        hasPassword: true,
        autoVersions: true,
        avatar: null,
      },
    });
  });

  it("suspended -> revoked", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    const gate = new UserGate(db);
    expect((await gate.checkUser(u.id)).status).toBe("ok");

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
    gate.invalidate(u.id);
    expect((await gate.checkUser(u.id)).status).toBe("revoked");
  });

  it("user not found -> revoked", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    expect((await gate.checkUser("00000000-0000-0000-0000-000000000000")).status).toBe("revoked");
  });

  it("shares the cache with check: a cache built by check() is used directly by checkUser without re-querying the DB", async () => {
    // Catches checkUser bypassing getRow. The race case below tells whether an old value was written to the cache, not whether the cache is used:
    // changing checkUser to await this.fetchRow() itself without touching the cache would leave the race case green.
    const { db } = await freshDb();
    let served = 0;
    const gate = new UserGate(db, {
      fetchRow: async (userId): Promise<GateRow> => {
        served += 1;
        return {
          id: userId,
          email: "shared@example.com",
          handle: "shared",
          displayName: "S",
          isAdmin: false,
          disabledAt: null,
          tokenVersion: 7,
          mustChangePassword: false,
          hasPassword: true,
          autoVersions: true,
          avatar: null,
        };
      },
      // "u-shared" isn't a user in the DB and has no default session row in tests; the session row isn't what this case guards, so a row is given directly.
      fetchSession: async () => ({ userId: "u-shared", expiresAt: new Date(Date.now() + 60_000) }),
    });

    expect((await gate.check("u-shared", 7, testSessionId("u-shared"))).status).toBe("ok"); // builds the cache
    expect((await gate.checkUser("u-shared")).status).toBe("ok"); // must hit the same one
    expect(served).toBe(1);
  });

  it("invalidated during the query -> the old data must not be written to the cache (the gen guard shares one path with check())", async () => {
    // This guards the gen guard itself: if another fetch wrote the cache by itself without the gen guard, a token would still work for 60 seconds after suspension.
    // "Whether the cache is used" is guarded by the previous case.
    const { db } = await freshDb();
    let served = 0;
    const gate = new UserGate(db, {
      fetchRow: async (userId): Promise<GateRow> => {
        served += 1;
        // The first one is deliberately slow, so the outside can invalidate before it returns
        if (served === 1) await new Promise(resolve => setTimeout(resolve, 20));
        return {
          id: userId,
          email: "race@example.com",
          handle: "race",
          displayName: "R",
          isAdmin: false,
          disabledAt: served === 1 ? null : new Date(),
          tokenVersion: 0,
          mustChangePassword: false,
          hasPassword: true,
          autoVersions: true,
          avatar: null,
        };
      },
    });

    const inFlight = gate.checkUser("u-race");
    gate.invalidate("u-race");
    expect((await inFlight).status).toBe("ok"); // this call uses the snapshot from the time of the query, which is reasonable

    // Key assertion: that old snapshot must not be written to the cache - the next one must query again (and get the suspended state).
    expect((await gate.checkUser("u-race")).status).toBe("revoked");
    expect(served).toBe(2);
  });
});

describe("UserGate.check session row (#388)", () => {
  it("row missing, belonging to someone else, expired -> revoked; all three first go through the user row (no session lookup when tv mismatches)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    const other = await insertUser(db);
    const gate = new UserGate(db);
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok");
    expect(await gate.check(u.id, 0, "00000000-0000-4000-8000-000000000000")).toEqual({ status: "revoked" });
    expect(await gate.check(u.id, 0, testSessionId(other.id))).toEqual({ status: "revoked" });
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, testSessionId(other.id)));
    expect(await new UserGate(db).check(other.id, 0, testSessionId(other.id))).toEqual({ status: "revoked" });
  });

  it("a cache hit also compares expires_at with now: cache 60 seconds, the row expires meanwhile -> revoked (the cache doesn't extend session lifetime)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    let now = Date.now();
    let fetched = 0;
    const gate = new UserGate(db, {
      now: () => now,
      fetchSession: async () => {
        fetched += 1;
        return { userId: u.id, expiresAt: new Date(now + 10_000) };
      },
    });
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("ok");
    now += 20_000; // past the row's expires_at but still within the cache TTL (60s)
    expect((await gate.check(u.id, 0, testSessionId(u.id))).status).toBe("revoked");
    expect(fetched).toBe(1); // this really is the cache-hit path
  });

  it("invalidateSession: calling it after the row is deleted makes the next check revoked immediately; without calling it the cache is still read (ok within 60 seconds)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    const sid = testSessionId(u.id);
    const gate = new UserGate(db);
    expect((await gate.check(u.id, 0, sid)).status).toBe("ok");
    await db.delete(sessions).where(eq(sessions.id, sid));
    expect((await gate.check(u.id, 0, sid)).status).toBe("ok"); // cache hit - so logout must call invalidateSession
    gate.invalidateSession(sid);
    expect((await gate.check(u.id, 0, sid)).status).toBe("revoked");
  });

  it("invalidated by invalidateSession during the query -> the old 'row still exists' must not be written to the cache (sessionGen guard)", async () => {
    const { db } = await freshDb();
    const u = await insertUser(db);
    const sid = testSessionId(u.id);
    let calls = 0;
    let release!: () => void;
    const gate = new UserGate(db, {
      fetchSession: async id => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>(resolve => (release = resolve));
          return { userId: u.id, expiresAt: new Date(Date.now() + 60_000) }; // snapshot from before the deletion
        }
        const [row] = await db.select({ userId: sessions.userId, expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, id));
        return row ?? null;
      },
    });
    const first = gate.check(u.id, 0, sid);
    await new Promise(resolve => setTimeout(resolve, 20));
    await db.delete(sessions).where(eq(sessions.id, sid));
    gate.invalidateSession(sid);
    release();
    expect((await first).status).toBe("ok"); // this call answers with the snapshot it read
    expect((await gate.check(u.id, 0, sid)).status).toBe("revoked");
    expect(calls).toBe(2);
  });
});
