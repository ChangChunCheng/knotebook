/** The image server is a local `node:http`; the fake IdP's `picture` points at it, and the download policy is injected to allow loopback and any port. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import type { AvatarFetchPolicy } from "../src/avatars/oidc-fetch.js";
import type { OidcAvatarJobResult } from "../src/avatars/oidc-job.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { cookieOf } from "./group-helpers.js";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { buildOidcApp, ssoRoundTrip, type OidcTestApp } from "./helpers/oidc-provider.js";
import { pngOf } from "./storage-helpers.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const OPEN_POLICY: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };

function pngFilled(size: number, fill: number): Buffer {
  const b = pngOf(size);
  b.fill(fill, 8);
  return b;
}

interface ImageRoute {
  status?: number;
  body?: Buffer;
  hold?: Promise<void>;
}
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

async function imageServer(initial: Record<string, ImageRoute>): Promise<{ base: string; requests: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    const route = initial[(req.url ?? "").split("?")[0]!];
    void (async () => {
      if (route?.hold) await route.hold;
      if (!route) return void res.writeHead(404).end();
      res.writeHead(route.status ?? 200, { "content-type": "image/png" });
      res.end(route.body ?? Buffer.alloc(0));
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => count };
}

/** Collector of background job results: `next()` waits for the next one (already-arrived ones first), no sleep. */
function settledQueue() {
  const seen: OidcAvatarJobResult[] = [];
  const waiting: Array<(r: OidcAvatarJobResult) => void> = [];
  const pending: OidcAvatarJobResult[] = [];
  return {
    seen,
    hooks: {
      onSettled: (r: OidcAvatarJobResult) => {
        seen.push(r);
        const w = waiting.shift();
        if (w) w(r);
        else pending.push(r);
      },
    },
    next: (): Promise<OidcAvatarJobResult> => {
      const r = pending.shift();
      if (r) return Promise.resolve(r);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("背景工作沒有在 8 秒內結束")), 8_000);
        waiting.push(res => {
          clearTimeout(timer);
          resolve(res);
        });
      });
    },
  };
}

async function app2(over: Parameters<typeof buildOidcApp>[1] = {}) {
  const q = settledQueue();
  const t = await buildOidcApp(
    { providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] },
    { avatarFetchPolicy: OPEN_POLICY, avatarJobHooks: q.hooks, ...over },
  );
  return { t, q };
}

const loginUrl = (t: OidcTestApp, key: string) => `/api/auth/oidc/login/${t.provider(key).id}`;
const avatarsOf = (t: OidcTestApp, userId: string) => t.db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
const userBy = async (t: OidcTestApp, email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]!;
const me = (t: OidcTestApp, cookies: Record<string, string>) => t.app.inject({ method: "GET", url: "/api/auth/me", cookies });
const sessionOf = (cookies: Record<string, string>) => ({ [SESSION_COOKIE]: cookies[SESSION_COOKIE]! });

describe("OIDC callback avatar: login", () => {
  it("first login (created): after the 302 the background creates the candidate and auto-selects it, /me avatar.pending is true", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 1) } });
    const { t, q } = await app2();
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/a.png` } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(await q.next()).toMatchObject({ outcome: "inserted" });
    const alice = await userBy(t, "alice@example.com");
    const rows = await avatarsOf(t, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isCurrent: true, oidcPictureUrl: `${img.base}/a.png` });
    const body = (await me(t, sessionOf(r.cookies))).json();
    expect(body.avatar).toEqual({ id: rows[0]!.id, v: 1, pending: true });
  });

  it("302 and session are returned first: with the image server stuck the login is already complete and /me has no avatar; the candidate appears only after release", async () => {
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 1), hold } });
    const { t, q } = await app2();
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/a.png` } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(r.callbackRes.headers.location).toBe("/");
    expect(r.cookies[SESSION_COOKIE]).toBeTruthy();
    const before = await me(t, sessionOf(r.cookies));
    expect(before.statusCode).toBe(200);
    expect(before.json().avatar).toBeNull();
    expect(q.seen).toHaveLength(0);
    release();
    expect(await q.next()).toMatchObject({ outcome: "inserted" });
    expect((await me(t, sessionOf(r.cookies))).json().avatar).not.toBeNull();
  });

  it("regular login (login): same URL is not fetched again, a new URL changes the image", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 1) }, "/b.png": { body: pngFilled(64, 2) } });
    const { t, q } = await app2();
    const claims = { sub: "ua", email: "alice@example.com" };
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { ...claims, picture: `${img.base}/a.png` } });
    await q.next();
    expect(img.requests()).toBe(1);
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { ...claims, picture: `${img.base}/a.png` } });
    expect(await q.next()).toMatchObject({ outcome: "skipped", reason: "same_url" });
    expect(img.requests()).toBe(1);
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { ...claims, picture: `${img.base}/b.png` } });
    expect(await q.next()).toMatchObject({ outcome: "replaced" });
    expect(img.requests()).toBe(2);
    const rows = await avatarsOf(t, (await userBy(t, "alice@example.com")).id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oidcPictureUrl: `${img.base}/b.png`, version: 2 });
  });

  it("ID token without picture, email in the ID token: userinfo not called, no candidate, last_picture_url is NULL", async () => {
    const { t, q } = await app2();
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com" } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(await q.next()).toMatchObject({ outcome: "skipped", reason: "no_picture" });
    expect(t.idp("a").counts.userinfo).toBe(0);
    const alice = await userBy(t, "alice@example.com");
    expect(await avatarsOf(t, alice.id)).toHaveLength(0);
    const [idn] = await t.db.select().from(userIdentities).where(eq(userIdentities.userId, alice.id));
    expect(idn!.lastPictureUrl).toBeNull();
  });

  it("ID token without email and picture, only userinfo carries picture: the userinfo one is used", async () => {
    const img = await imageServer({ "/u.png": { body: pngFilled(64, 3) } });
    const { t, q } = await app2();
    t.idp("a").omitFromIdToken(["email", "picture"]);
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/u.png` } });
    expect(await q.next()).toMatchObject({ outcome: "inserted" });
    expect(t.idp("a").counts.userinfo).toBe(1);
    const rows = await avatarsOf(t, (await userBy(t, "alice@example.com")).id);
    expect(rows[0]).toMatchObject({ oidcPictureUrl: `${img.base}/u.png` });
  });

  it("ID token and userinfo both have picture: the ID token's wins", async () => {
    const img = await imageServer({ "/id.png": { body: pngFilled(64, 4) } });
    const { t, q } = await app2();
    // userinfo is only called when email is missing; the userinfo picture points at a nonexistent path, which would give http_status if used.
    t.idp("a").omitFromIdToken(["email"]);
    t.idp("a").overrideNextUserinfo({ picture: `${img.base}/other.png` });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/id.png` } });
    expect(await q.next()).toMatchObject({ outcome: "inserted" });
    expect(t.idp("a").counts.userinfo).toBe(1);
  });

  it("image server returns 500: login still succeeds, no candidate", async () => {
    const img = await imageServer({ "/a.png": { status: 500 } });
    const { t, q } = await app2();
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/a.png` } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(r.callbackRes.headers.location).toBe("/");
    expect(await q.next()).toMatchObject({ outcome: "failed", reason: "http_status" });
    expect(await avatarsOf(t, (await userBy(t, "alice@example.com")).id)).toHaveLength(0);
  });

  it("production policy (not injected): picture pointing at 127.0.0.1:<random port> -> no candidate, reason is bad_port (port is checked before address), login still succeeds", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 1) } });
    const q = settledQueue();
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }] }, { avatarJobHooks: q.hooks });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "alice@example.com", picture: `${img.base}/a.png` } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(await q.next()).toMatchObject({ outcome: "failed", reason: "bad_port" });
    expect(img.requests()).toBe(0);
    expect(await avatarsOf(t, (await userBy(t, "alice@example.com")).id)).toHaveLength(0);
  });
});

async function linkCallback(t: OidcTestApp, key: string, cookies: Record<string, string>, claims: { sub: string; picture?: string }) {
  t.idp(key).setNextLogin(claims);
  const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/link/${t.provider(key).id}`, cookies, payload: {} });
  expect(start.statusCode, start.body).toBe(200);
  const url: string = start.json().url;
  const { code, state } = t.idp(key).authorize(url);
  const callbackPath = new URL(new URL(url).searchParams.get("redirect_uri")!).pathname;
  return t.app.inject({
    method: "GET",
    url: `${callbackPath}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { ...cookies, [OIDC_STATE_COOKIE]: start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value },
  });
}

describe("OIDC callback avatar: link", () => {
  it("intent=link: triggers, the candidate's identity_id is the newly linked row", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 5) } });
    const { t, q } = await app2();
    const alice = await insertPasswordUser(t.db);
    const callback = await linkCallback(t, "b", await cookieOf(alice.id), { sub: "sb", picture: `${img.base}/a.png` });
    expect(callback.headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);
    expect(await q.next()).toMatchObject({ outcome: "inserted" });
    const [idn] = await t.db.select().from(userIdentities).where(eq(userIdentities.userId, alice.id));
    const rows = await avatarsOf(t, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ identityId: idn!.id, oidcPictureUrl: `${img.base}/a.png` });
  });

  it("link failure (identity belongs to someone else): not scheduled; before the fence nothing belongs to the failing side", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 5) }, "/fence.png": { body: pngFilled(64, 7) } });
    const { t, q } = await app2();
    const bob = await insertPasswordUser(t.db);
    const alice = await insertPasswordUser(t.db);
    expect((await linkCallback(t, "b", await cookieOf(bob.id), { sub: "sb", picture: `${img.base}/a.png` })).headers.location).toBe(`/settings/login?linked=${t.provider("b").id}`);
    await q.next();
    const taken = await linkCallback(t, "b", await cookieOf(alice.id), { sub: "sb", picture: `${img.base}/a.png` });
    expect(taken.headers.location).toBe("/settings/login?link_error=identity_taken");
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "uf", email: "fence@example.com", picture: `${img.base}/fence.png` } });
    const fence = await userBy(t, "fence@example.com");
    for (let r = await q.next(); r.userId !== fence.id; r = await q.next()) {
      // Everything that appears before the fence's result is collected, then checked together at the end.
    }
    expect(q.seen.map(r => r.userId)).toEqual([bob.id, fence.id]);
  });
});

describe("OIDC callback avatar: prove and pending link don't trigger", () => {
  it("neither SSO prove nor the confirm_link callback schedules; another login that does trigger is used as a fence, confirming nothing came before it", async () => {
    const img = await imageServer({ "/a.png": { body: pngFilled(64, 6) }, "/fence.png": { body: pngFilled(64, 7) } });
    const { t, q } = await app2();
    // Pure SSO account U (A's identity, no picture, so the first-login job only gets no_picture).
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "ua", email: "u@example.com" } });
    expect(await q.next()).toMatchObject({ reason: "no_picture" });
    // B first-logs in with the same email -> confirm_link (with picture, but there is no identity row yet, so it must not be scheduled).
    const pend = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: loginUrl(t, "b"), claims: { sub: "ub", email: "u@example.com", picture: `${img.base}/a.png` } });
    const pending = pend.cookies[OIDC_PENDING_COOKIE]!;
    expect(pend.callbackRes.headers.location).toBe("/link-account");
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, Math.floor(Date.now() / 1000))!.pendingId;
    const cookies = { [OIDC_PENDING_COOKIE]: pending };
    const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies, payload: { pendingId } });
    expect(start.statusCode, start.body).toBe(200);
    t.idp("a").setNextLogin({ sub: "ua", email: "u@example.com", picture: `${img.base}/a.png` });
    const { code, state } = t.idp("a").authorize(start.json().url);
    const callback = await t.app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { ...cookies, [OIDC_STATE_COOKIE]: start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    // Fence: a login that does trigger (another user). A wrongly scheduled job would start earlier than the fence and has fewer steps than a whole SSO trip, so it would finish first; if it downloaded the image, the image server's request count would be one higher.
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: loginUrl(t, "a"), claims: { sub: "uf", email: "fence@example.com", picture: `${img.base}/fence.png` } });
    const fence = await userBy(t, "fence@example.com");
    for (let r = await q.next(); r.userId !== fence.id; r = await q.next()) {
      // Everything that appears before the fence's result is collected, then checked together at the end.
    }
    const u = await userBy(t, "u@example.com");
    expect(q.seen.map(r => r.userId)).toEqual([u.id, fence.id]);
    expect(img.requests()).toBe(1);
  });
});
