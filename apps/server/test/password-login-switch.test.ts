import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { apiTokens, oauthClients, siteSettings, users } from "../src/db/schema.js";
import { generateAccessToken } from "../src/auth/api-token.js";
import { buildTestApp, insertPasswordUser, testConfig } from "./helpers.js";
import { seedUser } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { OIDC_PENDING_COOKIE } from "../src/auth/oidc-pending.js";
import { PASSWORD_LOGIN_SETTINGS_MISSING_LOG } from "../src/auth/password-login.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
import { verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(verifyPassword).mockClear());

const PW = "correct-horse-battery-staple";
const login = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], email: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const turnOff = (db: Awaited<ReturnType<typeof buildTestApp>>["db"]) => db.update(siteSettings).set({ passwordLoginEnabled: false });

describe("POST /api/auth/login while password login is off (#187)", () => {
  it("six kinds of account all get 403 password_login_disabled with identical bodies; argon2 is not run", async () => {
    const { app, db } = await buildTestApp();
    const ok = await insertPasswordUser(db, { password: PW });
    const wrong = await insertPasswordUser(db, { password: PW });
    const ssoOnly = await seedUser(db);
    const disabled = await insertPasswordUser(db, { password: PW });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id));
    const admin = await insertPasswordUser(db, { password: PW });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    await turnOff(db);

    const bodies: string[] = [];
    for (const [email, password] of [
      [ok.email, PW],
      [wrong.email, "totally-wrong-password"],
      [`nobody-${randomUUID()}@example.com`, PW],
      [ssoOnly.email, PW],
      [disabled.email, PW],
      [admin.email, PW],
    ] as const) {
      const res = await login(app, email, password);
      expect(res.statusCode, email).toBe(403);
      expect(res.json().error.code).toBe("password_login_disabled");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
  });

  it("requests while off do not feed LoginThrottle: 6 attempts while off, then the first wrong password after re-enabling is 401, not 429", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    await turnOff(db);
    for (let i = 0; i < 6; i += 1) expect((await login(app, u.email, "wrong-password-xx")).statusCode).toBe(403);
    await db.update(siteSettings).set({ passwordLoginEnabled: true });
    expect((await login(app, u.email, "wrong-password-xx")).statusCode).toBe(401);
  });

  it("shape validation still runs first: invalid body -> 400, not 403", async () => {
    const { app, db } = await buildTestApp();
    await turnOff(db);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x@example.com" } });
    expect(res.statusCode).toBe(400);
  });

  it("env force + DB off -> normal login (correct 200, wrong 401 and throttled)", async () => {
    const { app, db } = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const u = await insertPasswordUser(db, { password: PW });
    await turnOff(db);
    expect((await login(app, u.email, PW)).statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await login(app, u.email, "wrong-password-xx")).statusCode).toBe(401);
    expect((await login(app, u.email, "wrong-password-xx")).statusCode).toBe(429);
  });

  it("unreadable site_settings row -> treated as on: login works and log.error is emitted", async () => {
    const logs = captureLogs();
    const { app, db } = await buildTestApp({}, logs.options);
    const u = await insertPasswordUser(db, { password: PW });
    await db.delete(siteSettings);
    expect((await login(app, u.email, PW)).statusCode).toBe(200);
    expect(logs.lines.some(l => l.level === "error" && l.msg === PASSWORD_LOGIN_SETTINGS_MISSING_LOG)).toBe(true);
  });
});

describe("paths that keep working while password login is off (#187)", () => {
  const A = "https://idp-a.example";

  it("first login via an external provider (auto-create on) still creates the account while password login is off", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    await turnOff(t.db);
    const email = `sso-${randomUUID()}@example.com`;
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: `s-${randomUUID()}`, email } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(1);
  });

  it("flagged account using Bearer while off -> 401 (mustChangePassword still blocks)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { mustChangePassword: true });
    const pat = generateAccessToken();
    await db.insert(apiTokens).values({ userId: u.id, kind: "pat", name: "pat", scope: "notes:read", accessTokenHash: createHash("sha256").update(pat).digest("hex") });
    await turnOff(db);
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${pat}` } })).statusCode).toBe(401);
  });

  it("password account with DB off, first SSO login with the same email -> /link-account, methods.password=true, linking by password succeeds and issues a session", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const u = await insertPasswordUser(t.db, { password: PW });
    await turnOff(t.db);
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: u.email } });
    expect(r.callbackRes.headers.location).toBe("/link-account");
    const cookies = { [OIDC_PENDING_COOKIE]: r.cookies[OIDC_PENDING_COOKIE]! };
    const pending = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies });
    expect(pending.json().methods.password).toBe(true);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies, payload: { password: PW, pendingId: pending.json().pendingId } });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "sa" }]);
  });

  it("wrong password on the link page while off -> 401 and counts toward LoginThrottle (6th attempt after 5 is 429, even with the correct password)", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const v = await insertPasswordUser(t.db, { password: PW });
    await turnOff(t.db);
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sv", email: v.email } });
    const cookies = { [OIDC_PENDING_COOKIE]: r.cookies[OIDC_PENDING_COOKIE]! };
    const pendingId = (await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies })).json().pendingId as string;
    const confirm = (password: string) => t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies, payload: { password, pendingId } });
    for (let i = 0; i < 5; i += 1) expect((await confirm("wrong-password-xx")).statusCode).toBe(401);
    expect((await confirm(PW)).statusCode).toBe(429);
  });
});

describe("turning password login off does not affect existing credentials (#187)", () => {
  it("password session from before: /api/auth/me 200 and token_version unchanged; PAT and OAuth access token still work on Bearer endpoints", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    const loginRes = await login(app, u.email, PW);
    const session = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const pat = generateAccessToken();
    await db.insert(apiTokens).values({ userId: u.id, kind: "pat", name: "pat", scope: "notes:read", accessTokenHash: createHash("sha256").update(pat).digest("hex") });
    const clientId = `client-${randomUUID()}`;
    await db.insert(oauthClients).values({ clientId, clientName: "App", redirectUris: ["http://localhost/cb"] });
    const oauth = generateAccessToken();
    await db.insert(apiTokens).values({
      userId: u.id, kind: "oauth", name: "App", scope: "notes:read", clientId,
      accessTokenHash: createHash("sha256").update(oauth).digest("hex"),
      refreshTokenHash: createHash("sha256").update(generateAccessToken()).digest("hex"),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const [before] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, u.id));

    await turnOff(db);

    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: session } })).statusCode).toBe(200);
    const [after] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, u.id));
    expect(after!.tv).toBe(before!.tv);
    // `GET /api/mcp` returns 405 once auth passes; a 401 means the Bearer was rejected.
    for (const token of [pat, oauth]) {
      const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(405);
    }
  });
});

describe("GET /api/auth/config passwordLogin.enabled is the effective value (#187)", () => {
  it.each([
    [true, false, true],
    [false, false, false],
    [true, true, true],
    [false, true, true],
  ] as const)("DB=%s, env force=%s -> %s", async (dbValue, forced, expected) => {
    const { app, db } = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: forced } });
    await db.update(siteSettings).set({ passwordLoginEnabled: dbValue });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json().passwordLogin).toEqual({ enabled: expected });
  });

  it("does not reveal whether env forces it: the response has only the enabled key", async () => {
    const { app } = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(Object.keys(res.json().passwordLogin)).toEqual(["enabled"]);
  });
});
