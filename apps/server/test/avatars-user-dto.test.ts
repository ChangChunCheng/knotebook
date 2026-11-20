import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { UserAvatarDto } from "@knotebook/shared";
import { buildTestApp, freshDb, insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildOidcApp, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { seedAvatarRow } from "./avatar-helpers.js";
import { userAvatars } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { UserGate } from "../src/auth/session.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";

const PW = "correct-horse-battery-staple";

/** alice's current avatar (version 3) plus an older non-current candidate (inserted first: if the read misses the is_current condition it picks that one up first); returns the DTO the current one should have. */
async function giveAlicePicture(db: Db, userId: string): Promise<UserAvatarDto> {
  await seedAvatarRow(db, { userId, originalSize: 4000, displaySize: 200 });
  const current = await seedAvatarRow(db, { userId, originalSize: 5000, displaySize: 300, isCurrent: true });
  await db.update(userAvatars).set({ version: 3 }).where(eq(userAvatars.id, current));
  return { id: current, v: 3, pending: false };
}

describe("UserDto.avatar: gate (GET /api/auth/me)", () => {
  it("alice with a current avatar (and a non-current candidate) -> only the current one is returned; bob with no avatar -> null", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(a.statusCode).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(bob.id) });
    expect(b.json().avatar).toBeNull();
  });

  it("current avatar with display image not generated yet -> pending: true", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 800, displaySize: 0, isCurrent: true });
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(res.json().avatar).toEqual({ id, v: 1, pending: true });
  });

  it("the gate has a 60 s cache: after replacing the current avatar /me still shows the old value until invalidate", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    const { app } = await buildTestApp({ db, gate });
    const alice = await seedUser(db);
    const first = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const cookies = await cookieOf(alice.id);
    const read = async () => (await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar;
    expect(await read()).toEqual({ id: first, v: 1, pending: false });

    await db.update(userAvatars).set({ isCurrent: false }).where(eq(userAvatars.id, first));
    const second = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    expect(await read()).toEqual({ id: first, v: 1, pending: false });
    gate.invalidate(alice.id);
    expect(await read()).toEqual({ id: second, v: 1, pending: false });
  });
});

describe("UserDto.avatar: hand-assembled generation points", () => {
  it("password login", async () => {
    const { app, db } = await buildTestApp();
    const alice = await insertPasswordUser(db);
    const bob = await insertPasswordUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: alice.email, password: PW } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: bob.email, password: PW } });
    expect(b.json().avatar).toBeNull();
    // Current avatar with display image pending: the hand-assembled generation points must carry pending: true too
    const carol = await insertPasswordUser(db);
    const waiting = await seedAvatarRow(db, { userId: carol.id, originalSize: 800, displaySize: 0, isCurrent: true });
    const c = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: carol.email, password: PW } });
    expect(c.json().avatar).toEqual({ id: waiting, v: 1, pending: true });
  });

  it("response of a successful password reset", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const alice = await insertPasswordUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${alice.id}/password-reset`, cookies: await cookieOf(admin.id), payload: { expiresInHours: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const res = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token: issued.json().token, newPassword: "brand-new-password-404" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().avatar).toEqual(expected);
  });

  it("OIDC pending link: response after confirming with a password", async () => {
    const A = "https://idp-a.example";
    const t = await buildOidcApp({ providers: [{ key: "b", issuerUrl: A, displayName: "B" }] });
    const alice = await insertPasswordUser(t.db, { email: "alice@x.example", password: PW });
    const expected = await giveAlicePicture(t.db, alice.id);
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: alice.email } });
    expect(r.callbackRes.headers.location).toBe("/link-account");
    const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, cookie, Math.floor(Date.now() / 1000))!.pendingId;
    const res = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie }, payload: { password: PW, pendingId } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.avatar).toEqual(expected);
  });

  it("registration: new account avatar is null", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "carol@x.example", password: PW, displayName: "Carol" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toHaveProperty("avatar", null);
  });

  it("accepting an invite: new account avatar is null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const issued = await app.inject({ method: "POST", url: "/api/admin/invites", cookies: await cookieOf(admin.id), payload: { expiresInDays: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const res = await app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: issued.json().token, email: "dave@x.example", password: PW, displayName: "Dave" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toHaveProperty("avatar", null);
  });
});

describe("UserDto.avatar: PATCH /api/auth/profile (the two RETURNING branches)", () => {
  it("changing only autoVersions (plain UPDATE branch): avatar equals /me", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(alice.id), payload: { autoVersions: false } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(me.json().avatar).toEqual(a.json().avatar);
    const b = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(bob.id), payload: { autoVersions: false } });
    expect(b.json().avatar).toBeNull();
    // Current avatar with display image pending: the response's pending must be true (the web uses it to decide whether to generate)
    const carol = await seedUser(db);
    const waiting = await seedAvatarRow(db, { userId: carol.id, originalSize: 800, displaySize: 0, isCurrent: true });
    const c = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(carol.id), payload: { autoVersions: false } });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().avatar).toEqual({ id: waiting, v: 1, pending: true });
  });

  it("changing handle (rename transaction branch): avatar non-null, null for people without an avatar", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(alice.id), payload: { handle: "alice-renamed" } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().handle).toBe("alice-renamed");
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(bob.id), payload: { handle: "bob-renamed" } });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().avatar).toBeNull();
  });
});
