import { describe, expect, it, onTestFinished } from "vitest";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { sessions } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, insertPasswordUser, TEST_SESSION_TTL, type TestApp } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";

type App = TestApp["app"];
type Res = Awaited<ReturnType<App["inject"]>>;

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-397";
const TTL = 3600;

function sessionCookieOf(res: Res): { jwt: string; maxAge: number | undefined } {
  const c = res.cookies.find(one => one.name === SESSION_COOKIE);
  expect(c, "回應應帶 session cookie").toBeDefined();
  return { jwt: c!.value, maxAge: c!.maxAge };
}

async function expiresAtOf(db: Db, sid: string): Promise<Date> {
  const [row] = await db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, sid));
  expect(row, `sessions 應有 ${sid} 這一列`).toBeDefined();
  return row!.expiresAt;
}

async function me(app: App, jwt: string): Promise<number> {
  return (await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: jwt } })).statusCode;
}

async function login(app: App, email: string, password = PASSWORD): Promise<Res> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** The three values of one issuance all equal `ttl`: cookie `Max-Age` and JWT `exp - iat` must match exactly; the row's `expires_at - now` allows +-5 s. */
async function expectIssuedWithTtl(app: App, db: Db, res: Res, ttl: number): Promise<string> {
  const { jwt, maxAge } = sessionCookieOf(res);
  expect(maxAge).toBe(ttl);
  const claims = decodeJwt(jwt);
  expect(claims.exp! - claims.iat!).toBe(ttl);
  const remaining = ((await expiresAtOf(db, claims.sid as string)).getTime() - Date.now()) / 1000;
  expect(Math.abs(remaining - ttl), `expires_at − now = ${remaining} s`).toBeLessThanOrEqual(5);
  // The row does not expire before the JWT: the swapped-in cookie is directly usable.
  expect(await me(app, jwt)).toBe(200);
  return jwt;
}

describe("sessionTtlSeconds takes effect immediately", () => {
  it("new login: after changing to 3600 all three values of a password login are 3600; the row of a login before the change keeps its expiry and the cookie still works", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await insertPasswordUser(db);

    const earlier = await login(app, u.email);
    const earlierJwt = await expectIssuedWithTtl(app, db, earlier, TEST_SESSION_TTL);
    const earlierSid = decodeJwt(earlierJwt).sid as string;
    const earlierExpiresAt = await expiresAtOf(db, earlierSid);

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    await expectIssuedWithTtl(app, db, await login(app, u.email), TTL);

    expect((await expiresAtOf(db, earlierSid)).getTime()).toBe(earlierExpiresAt.getTime());
    expect(await me(app, earlierJwt)).toBe(200);
  });

  it("change password: the re-issued session has all three values 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await insertPasswordUser(db);
    const { jwt } = sessionCookieOf(await login(app, u.email));

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: jwt },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(204);
    await expectIssuedWithTtl(app, db, res, TTL);
  });

  it("add password: the re-issued session has all three values 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await seedUser(db);

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({ method: "POST", url: "/api/auth/password/set", cookies: await cookieOf(u.id), payload: { newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(204);
    await expectIssuedWithTtl(app, db, res, TTL);
  });

  it("set a new password via a reset link: the re-issued session has all three values 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const target = await insertPasswordUser(db);
    const issued = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/password-reset`,
      cookies: await cookieOf(admin.id),
      payload: { expiresInHours: 1 },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const { token } = issued.json() as { token: string };

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token, newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(200);
    await expectIssuedWithTtl(app, db, res, TTL);
  });
});
