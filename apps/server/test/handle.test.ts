import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { backfillHandleRegistry, deriveHandle } from "../src/auth/handle.js";
import { hashPassword } from "../src/auth/password.js";
import { handleRenames, handles, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { cookieOf, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { legacyOidcApp } from "./helpers/oidc-provider.js";

/**
 * Invariant asserted on every path: after account creation `handles` has one `state='live'` row whose `handle` = `users.handle` and `user_id` = that user.
 * It catches the two serious regressions (admin bypassing the registry, registry and users diverging after a rename).
 */

async function registryOf(db: Db, email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  expect(user, email).toBeDefined();
  const [reg] = await db.select().from(handles).where(eq(handles.handle, user!.handle)).limit(1);
  return { user: user!, reg };
}

async function expectLiveRegistry(db: Db, email: string): Promise<{ handle: string }> {
  const { user, reg } = await registryOf(db, email);
  expect(reg, `registry 缺列：${user.handle}`).toBeDefined();
  expect(reg!.state).toBe("live");
  expect(reg!.userId).toBe(user.id);
  return { handle: user.handle };
}

async function addRegisteredUser(db: Db, email: string, handle: string): Promise<{ id: string; cookies: Record<string, string> }> {
  const [u] = await db.insert(users).values({ email, displayName: handle, handle }).returning({ id: users.id });
  await db.insert(handles).values({ handle, userId: u!.id, state: "live" });
  return { id: u!.id, cookies: await cookieOf(u!.id) };
}

async function spend(db: Db, userId: string, n: number, at = new Date()): Promise<void> {
  await db.insert(handleRenames).values(Array.from({ length: n }, () => ({ userId, renamedAt: at })));
}

async function renamesOf(db: Db, userId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(handleRenames).where(eq(handleRenames.userId, userId));
  return row!.n;
}

describe("deriveHandle (candidate order + probing)", () => {
  it("candidate order: preferred_username beats the email local-part", async () => {
    const { db } = await freshDb();
    expect(await deriveHandle(db, ["Cool.Name", "alice.lee@x.example".split("@")[0]], "11111111-aaaa-4bbb-8ccc-000000000001")).toBe(
      "cool-name",
    );
  });

  it("four fallthrough branches: missing / empty string / entirely non-ASCII (empty after conversion) / uuid-shaped (checked before truncation) -> falls back to the email local-part", async () => {
    const { db } = await freshDb();
    const uuid = "22222222-aaaa-4bbb-8ccc-000000000002";
    expect(await deriveHandle(db, [undefined, "alice"], uuid)).toBe("alice");
    expect(await deriveHandle(db, ["", "alice"], uuid)).toBe("alice");
    expect(await deriveHandle(db, ["日本語", "alice"], uuid)).toBe("alice");
    expect(await deriveHandle(db, ["550e8400-e29b-41d4-a716-446655440000", "alice"], uuid)).toBe("alice");
    // Partly-ASCII candidates do not fall through: what remains after non-ASCII runs become dashes is a valid candidate (only an empty or uuid-shaped one moves to the next candidate).
    expect(await deriveHandle(db, ["Ünsal", "alice"], uuid)).toBe("nsal");
  });

  it("all candidates fail -> user-<uuid8>", async () => {
    const { db } = await freshDb();
    expect(await deriveHandle(db, ["日本語", "!!!"], "33333333-aaaa-4bbb-8ccc-000000000003")).toBe("user-33333333");
  });

  it("collision probe: live holders of the name and of -2 are skipped -> -3", async () => {
    const { db } = await freshDb();
    const uuid = "44444444-aaaa-4bbb-8ccc-000000000004";
    const uuid2 = "44444444-aaaa-4bbb-8ccc-000000000044";
    await db.insert(users).values([
      { id: uuid, email: "seed@x.example", displayName: "S", handle: "seed-holder" },
      { id: uuid2, email: "seed-b@x.example", displayName: "S2", handle: "seed-holder-b" },
    ]);
    await db.insert(handles).values([
      { handle: "alice", userId: uuid, state: "live" },
      { handle: "alice-2", userId: uuid2, state: "live" },
    ]);
    expect(await deriveHandle(db, ["alice"], uuid)).toBe("alice-3");
  });

  it("probe limit of 20 -> falls back to user-<uuid8> (upper bound on write amplification)", async () => {
    const { db } = await freshDb();
    const uuid = "55555555-aaaa-4bbb-8ccc-000000000005";
    await db.insert(users).values({ id: uuid, email: "seed2@x.example", displayName: "S", handle: "seed2-holder" });
    const rows = [{ handle: "busy", userId: uuid, state: "live" as const }];
    for (let n = 2; n <= 25; n += 1) rows.push({ handle: `busy-${n}`, userId: uuid, state: "live" });
    await db.insert(handles).values(rows);
    expect(await deriveHandle(db, ["busy"], uuid)).toBe("user-55555555");
  });

  it("suffix length arithmetic: a 30-char base plus -2 fits exactly at the 32-char limit without re-truncation", async () => {
    const { db } = await freshDb();
    const uuid = "66666666-aaaa-4bbb-8ccc-000000000006";
    const base = `${"a".repeat(28)}-b`; // 30 chars, the 29th is a dash
    await db.insert(users).values({ id: uuid, email: "seed3@x.example", displayName: "S", handle: "seed3-holder" });
    await db.insert(handles).values({ handle: base, userId: uuid, state: "live" });
    const derived = await deriveHandle(db, [base], uuid);
    // A 30-char base plus the "-2" suffix is exactly 32, right at the limit, so no re-truncation (the re-truncate-then-trim path is only reached when the
    // suffix is 3+ chars and the cut lands on a dash; the same formula in the SQL backfill is guarded by migrate.test).
    expect(derived).toBe(`${"a".repeat(28)}-b-2`);
    expect(derived.length).toBeLessThanOrEqual(32);
  });
});

describe("bootstrap path (registry-first)", () => {
  it("env bootstrap creates the account: registry live row = users.handle; handle derived from the email local-part", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, { email: "Admin.Boss@corp.example", password: "a-very-long-pw" });
    const { handle } = await expectLiveRegistry(db, "admin.boss@corp.example");
    expect(handle).toBe("admin-boss");
  });

  it("double bootstrap (sequential): the second is a no-op and leaves no orphan registry row", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" });
    await initializeInstance(db, { email: "boss2@corp.example", password: "a-very-long-pw" });
    const allHandles = await db.select().from(handles);
    expect(allHandles).toHaveLength(1); // only the first call's row; the second returns early and must not leave an orphan for boss2
    expect(allHandles[0].handle).toBe("boss");
  });

  it("concurrent bootstrap: the loser must not commit an orphan registry row (the INSERT must come after the setupRow guard; the sequential variant never reaches the guard branch, only concurrency does)", async () => {
    const { db } = await freshDb();
    // Two different emails race for the single instance_setup row; the loser takes the in-transaction `if (!setupRow) return` branch (a normal COMMIT early exit).
    // If the registry INSERT came before the guard, the loser would leave a live row pointing at a nonexistent user and burn the name forever.
    // The instanceSetup PK decides the winner, so the result set is deterministic, not flaky.
    await Promise.all([
      initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" }),
      initializeInstance(db, { email: "other@corp.example", password: "a-very-long-pw" }),
    ]);
    const allHandles = (await db.select().from(handles)).map((row) => row.handle).sort();
    expect(allHandles).toHaveLength(1);
    expect(["boss", "other"]).toContain(allHandles[0]);
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].handle).toBe(allHandles[0]);
  });

  it("derived name held live -> probe steps aside to -2 (the fail-closed path where the PK is still hit after probing is a true race that single-threaded code can't produce without a mock - a known gap)", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "77777777-aaaa-4bbb-8ccc-000000000007", email: "x@x.example", displayName: "X", handle: "x-holder" });
    await db.insert(handles).values({ handle: "boss", userId: "77777777-aaaa-4bbb-8ccc-000000000007", state: "live" });
    await initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" });
    const { handle } = await expectLiveRegistry(db, "boss@corp.example");
    expect(handle).toBe("boss-2");
  });
});

describe("invite-accept account path (#285; registry-first and the retry contract)", () => {
  async function inviteApp() {
    const { app, db } = await buildTestApp();
    await db.insert(users).values({
      email: "admin@x.example",
      displayName: "Admin",
      isAdmin: true,
      passwordHash: await hashPassword("a-very-long-pw"),
      handle: "admin",
    });
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@x.example", password: "a-very-long-pw" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    return { app, db, cookies: { [cookie.name]: cookie.value } };
  }

  async function acceptVia(app: Awaited<ReturnType<typeof inviteApp>>["app"], cookies: Record<string, string>, body: object) {
    const issued = await app.inject({ method: "POST", url: "/api/admin/invites", cookies, payload: { expiresInDays: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    return app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: issued.json().token, ...body } });
  }

  const ACCEPT = { email: "new.user@x.example", password: "another-long-pw", displayName: "New" };

  it("derived from the email local-part; 201 body carries the handle; registry consistent", async () => {
    const { app, db, cookies } = await inviteApp();
    const res = await acceptVia(app, cookies, ACCEPT);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().handle).toBe("new-user");
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("email collision only inside the transaction (another connection holds an uncommitted row with the same email) -> 409 email_taken; the failed account creation does not burn a handle (transaction atomicity)", async () => {
    // The email pre-check outside the transaction rejects an already-committed duplicate, so an uncommitted row makes the collision happen inside the transaction, at users_email_unique.
    const { app, db, cookies } = await inviteApp();
    const before = (await db.select().from(handles)).map((row) => row.handle).sort();
    const holder = await db.$client.connect();
    let pending: ReturnType<typeof acceptVia> | undefined;
    try {
      await holder.query("begin");
      await holder.query("insert into users (email, display_name, handle) values ('new.user@x.example', 'H', 'holder-285')");
      pending = acceptVia(app, cookies, ACCEPT);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
    } finally {
      await holder.query("commit");
      holder.release();
    }
    const res = await pending!;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("email_taken");
    const after = (await db.select().from(handles)).map((row) => row.handle).sort();
    expect(after).toEqual(before);
  });

  it("derived name collision -> probe steps aside (-2), no 409; registry consistent", async () => {
    const { app, db, cookies } = await inviteApp();
    await db.insert(handles).values({ handle: "new-user", userId: "99999999-aaaa-4bbb-8ccc-000000000019", state: "live" });
    const res = await acceptVia(app, cookies, ACCEPT);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().handle).toBe("new-user-2");
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("derived name hits users_handle_unique (window-period shape) -> retries exhausted -> 4th attempt falls back to user-<uuid8>", async () => {
    const { app, db, cookies } = await inviteApp();
    // 'new-user' exists only in users.handle (no registry row): the deriveHandle probe can't see it, so only the INSERT into users collides; retries 1-3 collide the same way and the 4th falls back to uuid8.
    await db.insert(users).values({
      id: "12121212-aaaa-4bbb-8ccc-000000000112",
      email: "window@x.example",
      displayName: "W",
      handle: "new-user",
    });
    const res = await acceptVia(app, cookies, ACCEPT);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().handle).toMatch(/^user-[0-9a-f]{8}$/);
    await expectLiveRegistry(db, "new.user@x.example");
  });
  it("GET /api/admin/users list carries the handle", async () => {
    const { app, cookies } = await inviteApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].handle).toBe("admin");
  });
});

describe("OIDC account creation path (preferred_username)", () => {
  // File-private helpers, mirroring oidc-callback.test.ts.
  const ISSUER_URL = "https://idp.example.com";
  async function oidcApp() {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, db } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);
    return { app, db, fakeIdp };
  }

  async function loginAs(
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    fakeIdp: FakeIdp,
    claims: FakeIdpClaims,
  ) {
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find((c) => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    return res;
  }

  it("id_token with preferred_username -> handle uses it; registry consistent", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await loginAs(app, fakeIdp, { sub: "u1", email: "sso.user@corp.example", email_verified: true, preferred_username: "Cool.Person" });
    const { handle } = await expectLiveRegistry(db, "sso.user@corp.example");
    expect(handle).toBe("cool-person");
  });

  it("IdP gives no preferred_username -> falls back to the email local-part (no extra userinfo call - the gate is not loosened)", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await loginAs(app, fakeIdp, { sub: "u2", email: "plain.user@corp.example", email_verified: true });
    const { handle } = await expectLiveRegistry(db, "plain.user@corp.example");
    expect(handle).toBe("plain-user");
    expect(fakeIdp.counts.userinfo).toBe(0); // userinfo is not called anyway when the email is complete; it must not be called just for the handle
  });

  it("preferred_username empty string / entirely non-ASCII / uuid-shaped -> falls back to the email local-part", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    const cases: Array<[string, string, string]> = [
      ["", "e1@corp.example", "e1"],
      ["日本語", "e2@corp.example", "e2"],
      ["550e8400-e29b-41d4-a716-446655440000", "e3@corp.example", "e3"],
    ];
    for (const [preferred, email, expected] of cases) {
      await loginAs(app, fakeIdp, { sub: `s-${expected}`, email, email_verified: true, preferred_username: preferred });
      const { handle } = await expectLiveRegistry(db, email);
      expect(handle, email).toBe(expected);
    }
  });

  it("OIDC account creation hits users_handle_unique (window-period shape) -> the whole-transaction retry collides again -> oidc_exchange_failed (OIDC has no uuid8 exit; deterministic shape, a re-login can retry; the boot backfill converges the window)", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await db.insert(users).values({
      id: "13131313-aaaa-4bbb-8ccc-000000000013",
      email: "window2@x.example",
      displayName: "W2",
      handle: "sso-window",
    });
    fakeIdp.setNextLogin({ sub: "uw", email: "sso.window@corp.example", email_verified: true, preferred_username: "sso.window" });
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find((c) => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
  });

  it("when userinfo is called anyway (id_token lacks email), preferred_username is read from it too", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    // preferred_username must also be omitted from the id_token: otherwise oidc.ts already reads it from the id_token, and the line that reads it from
    // userinfo (its only consumer) has zero coverage and could be deleted with the test still green.
    fakeIdp.omitFromIdToken(["email", "email_verified", "preferred_username"]);
    await loginAs(app, fakeIdp, { sub: "u3", email: "via.userinfo@corp.example", email_verified: true, preferred_username: "From.Userinfo" });
    const { handle } = await expectLiveRegistry(db, "via.userinfo@corp.example");
    expect(handle).toBe("from-userinfo");
    expect(fakeIdp.counts.userinfo).toBe(1);
  });

  describe("#291 derived name takes a name someone else renamed away", () => {
    const rename = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], sessionValue: string, handle: string) =>
      app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle }, cookies: { [SESSION_COOKIE]: sessionValue } });

    it("first OIDC login: after shared-name is renamed away, another first login with the same preferred_username derives shared-name", async () => {
      const { app, db, fakeIdp } = await oidcApp();
      const res = await loginAs(app, fakeIdp, { sub: "o1", email: "first@corp.example", email_verified: true, preferred_username: "Shared.Name" });
      expect((await expectLiveRegistry(db, "first@corp.example")).handle).toBe("shared-name");
      const session = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      expect((await rename(app, session, "shared-renamed")).statusCode).toBe(200);

      await loginAs(app, fakeIdp, { sub: "o2", email: "second@corp.example", email_verified: true, preferred_username: "Shared.Name" });
      expect((await expectLiveRegistry(db, "second@corp.example")).handle).toBe("shared-name");
    });
  });
});

describe("#291 registration derived name takes a name someone else renamed away (register path)", () => {
  const rename = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], sessionValue: string, handle: string) =>
    app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle }, cookies: { [SESSION_COOKIE]: sessionValue } });

    it("register: after pat renames to pat-renamed, the next pat@y registration derives pat (no longer steps aside to pat-2)", async () => {
      const { app, db } = await buildTestApp();
      const password = "correct-horse-battery-staple";
      const first = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "pat@x.example", password, displayName: "Pat" } });
      expect(first.statusCode).toBe(201);
      expect(first.json().handle).toBe("pat");
      const session = first.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      expect((await rename(app, session, "pat-renamed")).statusCode).toBe(200);

      const second = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "pat@y.example", password, displayName: "Pat Y" } });
      expect(second.statusCode).toBe(201);
      expect((await expectLiveRegistry(db, "pat@y.example")).handle).toBe("pat");
    });
});

describe("boot backfill + DTO", () => {
  it("backfillHandleRegistry is idempotent; a swallowed conflict row logs a warning", async () => {
    const { db } = await freshDb();
    await db.insert(users).values([
      { id: "aaaaaaaa-aaaa-4bbb-8ccc-00000000000a", email: "a@x.example", displayName: "A", handle: "alice" },
      { id: "bbbbbbbb-aaaa-4bbb-8ccc-00000000000b", email: "b@x.example", displayName: "B", handle: "bob" },
    ]);
    const warns: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warns.push(args), info: () => {} } as unknown as pino.Logger;
    await backfillHandleRegistry(db, logger);
    expect((await db.select().from(handles))).toHaveLength(2);
    await backfillHandleRegistry(db, logger);
    expect((await db.select().from(handles))).toHaveLength(2);
    expect(warns).toHaveLength(0);

    // alice's name is held by someone else's registry row (window-period collision); the backfill swallows it and warns.
    await db.insert(users).values({ id: "cccccccc-aaaa-4bbb-8ccc-00000000000c", email: "c@x.example", displayName: "C", handle: "charlie" });
    await db.update(handles).set({ userId: "bbbbbbbb-aaaa-4bbb-8ccc-00000000000b" }).where(eq(handles.handle, "alice"));
    await db.update(users).set({ handle: "charlie" }).where(eq(users.email, "c@x.example"));
    await db.insert(handles).values({ handle: "charlie", userId: "aaaaaaaa-aaaa-4bbb-8ccc-00000000000a", state: "live" });
    await backfillHandleRegistry(db, logger);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("#291 backfill clears released rows first: all window-period released rows are removed, every user has a live row, no warning, info logs the cleared count; a rerun logs no info", async () => {
    const { db } = await freshDb();
    const A = "aaaaaaaa-aaaa-4bbb-8ccc-00000000001a";
    const B = "bbbbbbbb-aaaa-4bbb-8ccc-00000000001b";
    const C = "cccccccc-aaaa-4bbb-8ccc-00000000001c";
    await db.insert(users).values([
      { id: A, email: "alpha@x.example", displayName: "A", handle: "alpha" },
      { id: B, email: "beta@x.example", displayName: "B", handle: "beta" },
      { id: C, email: "gamma@x.example", displayName: "C", handle: "gamma" },
    ]);
    const now = new Date();
    await db.insert(handles).values([
      { handle: "alpha", userId: A, state: "live" },
      { handle: "alpha-old", userId: A, state: "released", releasedAt: now }, // ordinary window-period released row
      { handle: "beta", userId: B, state: "released", releasedAt: now }, // B's current name only has B's own released row
      { handle: "gamma", userId: A, state: "released", releasedAt: now }, // C's current name is held by someone else's released row
    ]);
    const warns: unknown[][] = [];
    const infos: unknown[][] = [];
    const logger = { warn: (...a: unknown[]) => warns.push(a), info: (...a: unknown[]) => infos.push(a) } as unknown as pino.Logger;
    await backfillHandleRegistry(db, logger);
    expect(await db.select().from(handles).where(eq(handles.state, "released"))).toHaveLength(0);
    for (const email of ["alpha@x.example", "beta@x.example", "gamma@x.example"]) await expectLiveRegistry(db, email);
    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(1);
    expect(infos[0]![0]).toEqual({ purged: 3 });
    await backfillHandleRegistry(db, logger);
    expect(infos).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });

  it("structure guard: index.ts calls the backfill before app.listen", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
      "utf8",
    );
    // Anchor on the literal call site ("backfillHandleRegistry(db"), not just the function name: that would match the import at the top of the file,
    // which is always before listen, so moving or deleting the call would stay green.
    const callAt = src.indexOf("backfillHandleRegistry(db");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 backfillHandleRegistry(db…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "補登必須在 listen 之前（否則與首個改名請求可交錯）").toBeLessThan(listenAt);
  });

  it("/api/auth/me and the login DTO both carry the handle (GateUser/GateRow wiring)", async () => {
    const { app, db } = await buildTestApp();
    
    await db.insert(users).values({
      email: "who@x.example",
      displayName: "Who",
      passwordHash: await hashPassword("a-very-long-pw"),
      handle: "whoami",
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "who@x.example", password: "a-very-long-pw" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().handle).toBe("whoami");
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [cookie.name]: cookie.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().handle).toBe("whoami");
  });
});

describe("rename PATCH /api/auth/profile", () => {
  async function userApp(handle = "renamer") {
    const { app, db } = await buildTestApp();
    const [me] = await db
      .insert(users)
      .values({
        email: "renamer@x.example",
        displayName: "R",
        passwordHash: await hashPassword("a-very-long-pw"),
        handle,
      })
      .returning({ id: users.id });
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "renamer@x.example", password: "a-very-long-pw" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    return { app, db, me: me!, cookies: { [cookie.name]: cookie.value } };
  }

  async function userRow(db: Db, id: string) {
    const [u] = await db.select().from(users).where(eq(users.id, id));
    return u!;
  }

  async function handleRow(db: Db, handle: string) {
    return (await db.select().from(handles).where(eq(handles.handle, handle)))[0];
  }

  function rename(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookies: Record<string, string>, handle: string) {
    return app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle }, cookies });
  }

  it("successful rename: users and registry both written, old-name row deleted, one rename record, /me returns the new value immediately (gate.invalidate)", async () => {
    const { app, db, me, cookies } = await userApp();
    const res = await rename(app, cookies, "New-Name");
    expect(res.statusCode).toBe(200);
    // Shape lock: the PATCH response is exactly the full UserDto, nothing more or less (version history adds autoVersions).
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["id", "email", "handle", "displayName", "isAdmin", "mustChangePassword", "hasPassword", "autoVersions", "avatar"].sort(),
    );
    expect(body.handle).toBe("new-name");

    const { handle } = await expectLiveRegistry(db, "renamer@x.example");
    expect(handle).toBe("new-name");
    expect(await db.select().from(handles).where(eq(handles.handle, "renamer"))).toHaveLength(0);
    expect(await renamesOf(db, me.id)).toBe(1);

    // gate.invalidate: /me reflects the change immediately instead of waiting for the 60s cache TTL.
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(meRes.json().handle).toBe("new-name");
  });

  it("invalid format -> 400 invalid_body (validated first, never reaches the DB CHECK as a 500); not logged in -> 401", async () => {
    const { app, cookies } = await userApp();
    for (const bad of ["Bad Name!", "", "-abc", "a".repeat(33), "550e8400-e29b-41d4-a716-446655440000"]) {
      const res = await rename(app, cookies, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code, bad).toBe("invalid_body");
    }
    for (const payload of [{}, { handle: 123 }]) {
      const res = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload, cookies });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    const anon = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "x" } });
    expect(anon.statusCode).toBe(401);
  });

  it("renaming to someone else's live name or to one's own current name (including uppercase) -> 409 handle_taken (a self-rename must not take the DELETE short-circuit)", async () => {
    const { app, db, cookies } = await userApp();
    await db.insert(handles).values({ handle: "occupied", userId: "14141414-aaaa-4bbb-8ccc-000000000014", state: "live" });
    for (const taken of ["occupied", "renamer", "RENAMER"]) {
      const res = await rename(app, cookies, taken);
      expect(res.statusCode, taken).toBe(409);
      expect(res.json().error.code, taken).toBe("handle_taken");
    }
  });

  it("window-period shape (own current name has no registry row) renamed to one's own current name -> 409 handle_taken; no rename record, users.handle unchanged", async () => {
    const { app, db, me, cookies } = await userApp();
    await db.delete(handles).where(eq(handles.handle, "renamer"));
    const res = await rename(app, cookies, "renamer");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("handle_taken");
    expect(await renamesOf(db, me.id)).toBe(0);
    expect((await userRow(db, me.id)).handle).toBe("renamer");
  });

  it("renaming back to one's own old name (including uppercase) -> 200; the old-name row returns to the user as live; the row of the just-abandoned name is deleted", async () => {
    const { app, db, me, cookies } = await userApp();
    expect((await rename(app, cookies, "second-name")).statusCode).toBe(200);
    const back = await rename(app, cookies, "renamer");
    expect(back.statusCode).toBe(200);
    const row = await handleRow(db, "renamer");
    expect(row?.userId).toBe(me.id);
    expect(row?.state).toBe("live");
    expect(await handleRow(db, "second-name")).toBeUndefined();
    expect(await renamesOf(db, me.id)).toBe(2);

    expect((await rename(app, cookies, "third-name")).statusCode).toBe(200);
    expect((await rename(app, cookies, "SECOND-NAME")).statusCode).toBe(200);
    expect((await userRow(db, me.id)).handle).toBe("second-name");
  });

  it("someone takes my old name -> 200; the name goes to the taker, each gets one rename record", async () => {
    const { app, db, me, cookies } = await userApp();
    expect((await rename(app, cookies, "renamer-new")).statusCode).toBe(200);
    const y = await addRegisteredUser(db, "y@x.example", "yuser");
    expect((await rename(app, y.cookies, "renamer")).statusCode).toBe(200);
    expect((await userRow(db, y.id)).handle).toBe("renamer");
    const row = await handleRow(db, "renamer");
    expect(row?.userId).toBe(y.id);
    expect(row?.state).toBe("live");
    expect(await renamesOf(db, me.id)).toBe(1);
    expect(await renamesOf(db, y.id)).toBe(1);
  });

  it("quota can't be bypassed: A->B back and forth five times all 200, the sixth 429", async () => {
    const { app, db, me, cookies } = await userApp();
    for (const target of ["b5", "renamer", "b5", "renamer", "b5"]) {
      expect((await rename(app, cookies, target)).statusCode, target).toBe(200);
    }
    const sixth = await rename(app, cookies, "renamer");
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe("too_many_requests");
    expect((await userRow(db, me.id)).handle).toBe("b5");
    expect(await renamesOf(db, me.id)).toBe(5);
  });

  it("same-user concurrency on the quota: it is counted after the user's row lock, so a queued rename sees the earlier committed record -> 429", async () => {
    const { app, db, me, cookies } = await userApp();
    const pool = db.$client;
    const c = await pool.connect();
    let req: ReturnType<typeof rename> | undefined;
    let interleave: string | undefined;
    try {
      await c.query("begin");
      await c.query("select id from users where id = $1 for update", [me.id]);
      await c.query("insert into handle_renames (user_id) select $1 from generate_series(1, 5)", [me.id]);
      req = rename(app, cookies, "racer");
      interleave = await waitForBlockedOrSettled(pool, req);
    } finally {
      try {
        await c.query("commit");
      } finally {
        c.release();
      }
    }
    const res = await req!;
    expect(interleave).toBe("blocked");
    expect(res.statusCode).toBe(429);
    expect((await userRow(db, me.id)).handle).toBe("renamer");
    expect(await renamesOf(db, me.id)).toBe(5);
    expect(await handleRow(db, "racer")).toBeUndefined();
  });

  describe("claiming a name while someone else releases it (deterministic interleave)", () => {
    async function pendingRelease(commit: boolean) {
      const ctx = await userApp();
      const x = await addRegisteredUser(ctx.db, "x@x.example", "taken-x");
      const pool = ctx.db.$client;
      const c = await pool.connect();
      let req: ReturnType<typeof rename> | undefined;
      let interleave: string | undefined;
      try {
        await c.query("begin");
        await c.query("insert into handles (handle, user_id, state) values ('x-next', $1, 'live')", [x.id]);
        await c.query("delete from handles where handle = 'taken-x' and user_id = $1", [x.id]);
        await c.query("update users set handle = 'x-next' where id = $1", [x.id]);
        req = rename(ctx.app, ctx.cookies, "taken-x");
        interleave = await waitForBlockedOrSettled(pool, req);
      } finally {
        try {
          await c.query(commit ? "commit" : "rollback");
        } finally {
          c.release();
        }
      }
      return { ...ctx, x, interleave, res: await req! };
    }

    it("X commits -> I get the name, 200", async () => {
      const { db, me, interleave, res } = await pendingRelease(true);
      expect(interleave).toBe("blocked");
      expect(res.statusCode).toBe(200);
      const row = await handleRow(db, "taken-x");
      expect(row?.userId).toBe(me.id);
      expect(row?.state).toBe("live");
      expect((await userRow(db, me.id)).handle).toBe("taken-x");
    });

    it("X rolls back -> 409 handle_taken, my name and quota unchanged", async () => {
      const { db, me, x, interleave, res } = await pendingRelease(false);
      expect(interleave).toBe("blocked");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("handle_taken");
      expect((await userRow(db, me.id)).handle).toBe("renamer");
      expect(await renamesOf(db, me.id)).toBe(0);
      const xRow = await handleRow(db, "taken-x");
      expect(xRow?.userId).toBe(x.id);
      expect(xRow?.state).toBe("live");
    });
  });

  it("failures don't spend quota and the fields sent along aren't written either: after 409 and 429 the rename records don't grow and displayName is unchanged", async () => {
    const { app, db, me, cookies } = await userApp();
    await db.insert(handles).values({ handle: "occupied", userId: "14141414-aaaa-4bbb-8ccc-000000000014", state: "live" });
    const taken = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "occupied", displayName: "Changed" }, cookies });
    expect(taken.statusCode).toBe(409);
    expect(await renamesOf(db, me.id)).toBe(0);
    expect((await userRow(db, me.id)).displayName).toBe("R");

    await spend(db, me.id, 5);
    const quota = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "nope", displayName: "Changed" }, cookies });
    expect(quota.statusCode).toBe(429);
    expect(await renamesOf(db, me.id)).toBe(5);
    expect((await userRow(db, me.id)).displayName).toBe("R");
  });

  it("quota of 5 per day (counted from rename records, not in memory): the 6th is 429", async () => {
    const { app, db, me, cookies } = await userApp();
    // Inserting 5 of the user's own rename records for today is faster than renaming five times and checks the counting source.
    await spend(db, me.id, 5);
    const res = await rename(app, cookies, "one-more");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("too_many_requests");
    // A 429 must roll back the whole transaction: users.handle unchanged, no registry row for the new name.
    const [me2] = await db.select().from(users).where(eq(users.email, "renamer@x.example"));
    expect(me2.handle).toBe("renamer");
    const claimed = await db.select().from(handles).where(eq(handles.handle, "one-more"));
    expect(claimed).toHaveLength(0);
  });

  it("count boundary and per-user filter: 4 own records today plus 5 of someone else's today -> still 200 (others' quota must not count against me)", async () => {
    const { app, db, me, cookies } = await userApp();
    const other = "17171717-aaaa-4bbb-8ccc-000000000017";
    await db.insert(users).values({ id: other, email: "their@x.example", displayName: "T", handle: "their" });
    await spend(db, me.id, 4);
    await spend(db, other, 5);
    const res = await rename(app, cookies, "fifth-today");
    expect(res.statusCode).toBe(200); // the user's 5th rename (4 already counted); only the 6th gets 429
  });

  it("own current name not in the registry (window-period shape) -> rename 200, not 500", async () => {
    const { app, db, me, cookies } = await userApp();
    // Window-period shape: delete the user's own registry row (simulates an account created during the rollback window).
    await db.delete(handles).where(eq(handles.handle, "renamer"));
    const res = await rename(app, cookies, "post-window");
    expect(res.statusCode).toBe(200);
    expect(await handleRow(db, "renamer")).toBeUndefined();
    const { handle } = await expectLiveRegistry(db, "renamer@x.example");
    expect(handle).toBe("post-window");
    expect(await renamesOf(db, me.id)).toBe(1);
  });

  it("registry row of the old name belongs to someone else -> rename 200, the other row is not deleted", async () => {
    const { app, db, me, cookies } = await userApp();
    // Inconsistent-state fixture: the registry row for 'renamer' belongs to someone else; the DELETE carries user_id, so it deletes 0 rows.
    await db.update(handles).set({ userId: "15151515-aaaa-4bbb-8ccc-000000000015" }).where(eq(handles.handle, "renamer"));
    const res = await rename(app, cookies, "should-pass");
    expect(res.statusCode).toBe(200);
    const other = await handleRow(db, "renamer");
    expect(other?.userId).toBe("15151515-aaaa-4bbb-8ccc-000000000015");
    expect(other?.state).toBe("live");
    expect((await userRow(db, me.id)).handle).toBe("should-pass");
  });
});

describe("rename - additional coverage", () => {
  async function userApp2() {
    const { app, db } = await buildTestApp();
    await db.insert(users).values({
      email: "renamer2@x.example",
      displayName: "R2",
      passwordHash: await hashPassword("a-very-long-pw"),
      handle: "renamer2",
    });
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "renamer2@x.example", password: "a-very-long-pw" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    return { app, db, cookies: { [cookie.name]: cookie.value } };
  }

  it("rename hits users_handle_unique (window-period shape - the target name exists only in users.handle, no registry row) -> 409 not 500 (the other half of the discrimination contract)", async () => {
    const { app, db, cookies } = await userApp2();
    // The window-period account is inserted after the backfill: 'wanted' has no registry row, so the INSERT into handles passes
    // and only the UPDATE of users hits users_handle_unique.
    await db.insert(users).values({ id: "16161616-aaaa-4bbb-8ccc-000000000016", email: "w3@x.example", displayName: "W3", handle: "wanted" });
    const res = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "wanted" }, cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("handle_taken");
  });

  it("quota counts only the last 24h: 5 expired (2 days ago) rename records -> rename 200 (window pinned from both sides)", async () => {
    const { app, db, cookies } = await userApp2();
    const [me] = await db.select().from(users).where(eq(users.email, "renamer2@x.example"));
    await spend(db, me!.id, 5, new Date(Date.now() - 2 * 86_400_000));
    const res = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "fresh-name" }, cookies });
    expect(res.statusCode).toBe(200);
  });

  it("old name comes from the SELECT inside the transaction, not the gate's 60s cache (lagging multi-instance shape: the cached old name was already changed elsewhere, and releasing it would leave the current name as a live orphan)", async () => {
    const { app, db, cookies } = await userApp2();
    await app.inject({ method: "GET", url: "/api/auth/me", cookies }); // warm the gate cache (handle='renamer2')
    // Simulates another instance having already renamed: write the DB directly, not through this instance's endpoint, so this instance's cache is not invalidated.
    const [me] = await db.select().from(users).where(eq(users.email, "renamer2@x.example"));
    await db.insert(handles).values({ handle: "external-name", userId: me!.id, state: "live" });
    await db.delete(handles).where(eq(handles.handle, "renamer2"));
    await db.update(users).set({ handle: "external-name" }).where(eq(users.id, me!.id));

    const res = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "final-name" }, cookies });
    expect(res.statusCode).toBe(200);
    // The real code deletes the DB's current name 'external-name'; a variant using the cached old name would delete 0 rows and leave 'external-name' as a live orphan.
    expect(await db.select().from(handles).where(eq(handles.handle, "external-name"))).toHaveLength(0);
    const { handle } = await expectLiveRegistry(db, "renamer2@x.example");
    expect(handle).toBe("final-name");
  });
});
