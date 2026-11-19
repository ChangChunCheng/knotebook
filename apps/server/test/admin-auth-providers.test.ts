import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authProviders } from "../src/db/schema.js";
import { openClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const NUL = String.fromCodePoint(0);
/** A lone high surrogate (U+D800): serializes to `\ud800` in JSON and still parses back on the server as a lone surrogate. */
const LONE = String.fromCharCode(0xd800);
const base = { template: "oidc", displayName: "Corp SSO", issuerUrl: "https://idp.example.com", clientId: "knotebook" } as const;

describe("GET/POST /api/admin/auth/providers (#187)", () => {
  it("both endpoints are site-admin only (non-admin 403, not signed in 401)", async () => {
    const { app, db } = await adminApp();
    await expectAdminOnly(app, db, "GET", "/api/admin/auth/providers");
    await expectAdminOnly(app, db, "POST", "/api/admin/auth/providers", base);
  });

  it("POST create: 201, always disabled, hasSecret, callbackUrl is <PUBLIC_URL>/api/auth/oidc/callback/<id>; response contains no form of the secret; DB ciphertext decrypts with the id as AAD", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, clientSecret: "s3cret-value", template: "gitlab" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ template: "gitlab", displayName: "Corp SSO", issuerUrl: "https://idp.example.com", clientId: "knotebook", hasSecret: true, enabled: false, autoCreateEnabled: false, legacyCallback: false, insecureIssuer: false, issuerResolved: false });
    expect(body.callbackUrl).toBe(`http://localhost:3000/api/auth/oidc/callback/${body.id}`);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    for (const forbidden of ["s3cret-value", "clientSecretEncrypted", "client_secret", "\"ct\"", "\"iv\"", "\"tag\"", "keyId"]) {
      expect(res.body, forbidden).not.toContain(forbidden);
    }
    const row = await providerRow(db, body.id);
    expect(row!.enabled).toBe(false);
    expect(row!.autoCreateEnabled).toBe(false);
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("s3cret-value");
  });

  it("POST with autoCreateEnabled -> 400 invalid_body, no row created (the create API doesn't accept it)", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, autoCreateEnabled: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect(await db.select().from(authProviders)).toHaveLength(0);
  });

  it("GET list carries autoCreateEnabled", async () => {
    const { app, db, cookies } = await adminApp();
    const x = await seedAuthProvider(db, { issuerUrl: "https://x.example", sortOrder: 0, autoCreateEnabled: true });
    const y = await seedAuthProvider(db, { issuerUrl: "https://y.example", sortOrder: 1, autoCreateEnabled: false });
    const res = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    const list = res.json().providers as Array<{ id: string; autoCreateEnabled: boolean }>;
    expect(list.map(p => [p.id, p.autoCreateEnabled])).toEqual([[x.id, true], [y.id, false]]);
  });

  it("POST without clientSecret -> hasSecret false, DB ciphertext NULL", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.statusCode).toBe(201);
    expect(res.json().hasSecret).toBe(false);
    expect((await providerRow(db, res.json().id))!.clientSecretEncrypted).toBeNull();
  });

  it("(#299) POST without clientId -> 201, clientId null, always disabled, callbackUrl carries the response id; DB client_id NULL", async () => {
    const { app, db, cookies } = await adminApp();
    const { clientId: _omit, ...noClientId } = base;
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: noClientId });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ clientId: null, enabled: false });
    expect(body.callbackUrl.endsWith(`/api/auth/oidc/callback/${body.id}`)).toBe(true);
    expect((await providerRow(db, body.id))!.clientId).toBeNull();
  });

  it("POST sortOrder goes after the current maximum (new provider sorts last)", async () => {
    const { app, db, cookies } = await adminApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", sortOrder: 7 });
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.json().sortOrder).toBe(8);
  });

  it("POST sortOrder is capped at 100000 (= the PATCH limit; the edit form sending the original value back stays valid)", async () => {
    const { app, db, cookies } = await adminApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", sortOrder: 100_000 });
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.json().sortOrder).toBe(100_000);
  });

  it("GET list: order (sortOrder -> createdAt -> id), legacy callbackUrl is the old path, http issuer flagged insecure, resolved flagged issuerResolved; no secret", async () => {
    const { app, db, cookies } = await adminApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: "http://idp.lan", legacyCallback: true, sortOrder: 1, clientSecret: "legacy-secret" });
    const first = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/", resolvedIssuer: "https://gitlab.example", sortOrder: 0, displayName: "<b>Corp</b> & Co" });
    const res = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    expect(res.statusCode).toBe(200);
    const list = res.json().providers as Array<Record<string, unknown>>;
    expect(list.map(p => p.id)).toEqual([first.id, legacy.id]);
    expect(list[0]).toMatchObject({ displayName: "<b>Corp</b> & Co", issuerResolved: true, insecureIssuer: false, callbackUrl: `http://localhost:3000/api/auth/oidc/callback/${first.id}` });
    expect(list[1]).toMatchObject({ legacyCallback: true, insecureIssuer: true, issuerResolved: false, hasSecret: true, callbackUrl: "http://localhost:3000/api/auth/oidc/callback" });
    expect(res.body).not.toContain("legacy-secret");
    expect(res.body).not.toContain("clientSecretEncrypted");
  });

  it("POST http issuer -> 201 and one warn line (warn logged at save time)", async () => {
    const logs = captureLogs();
    const { app, cookies } = await adminApp({}, logs.options);
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, issuerUrl: "http://idp.lan" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().insecureIssuer).toBe(true);
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 是明文 http");
    expect(line).toBeDefined();
    expect(line!.level).toBe("warn");
    expect(line!.obj).toMatchObject({ providerId: res.json().id });
  });

  // One-to-one with the CHECKs of 0014: shapes that zod lets through but a CHECK rejects would become a 500.
  it.each([
    ["大寫 scheme（CHECK 大小寫敏感）", { issuerUrl: "HTTPS://idp.example.com" }, "The issuer URL must start with lowercase http:// or https://."],
    ["issuer 513 字", { issuerUrl: `https://idp.example.com/${"a".repeat(489)}` }, "The issuer URL can be at most 512 characters."],
    ["issuer 不是網址", { issuerUrl: "https://" }, "The issuer is not a valid URL."],
    ["issuer 格式錯又帶帳密（refine 不得 throw 成 500）", { issuerUrl: "https://user:pass@ho st/v1" }, "The issuer is not a valid URL."],
    ["issuer 帶帳密 user:pass@", { issuerUrl: "https://user:pass@idp.example.com" }, "The issuer URL can't contain a username or password."],
    ["issuer 只帶 user@", { issuerUrl: "https://user@idp.example.com" }, "The issuer URL can't contain a username or password."],
    ["顯示名 41 個 code point（emoji，UTF-16 長度 82）", { displayName: "😀".repeat(41) }, "The display name must be 1 to 40 characters."],
    ["顯示名只有空白", { displayName: "   " }, "The display name must be 1 to 40 characters."],
    ["顯示名含 NUL", { displayName: `a${NUL}b` }, "contains characters that can't be stored."],
    ["client id 513 字", { clientId: "c".repeat(513) }, "The client ID must be 1 to 512 characters."],
    // #299: clientId may be omitted, but an empty/all-whitespace string is still 400 (not treated as "not provided"), and null is rejected.
    ["client id 空字串", { clientId: "" }, "The client ID must be 1 to 512 characters."],
    ["client id 只有空白", { clientId: "   " }, "The client ID must be 1 to 512 characters."],
    ["client id 為 null", { clientId: null }, "Invalid request body."],
    ["clientSecret 空字串", { clientSecret: "" }, "The client secret can't be empty"],
    ["clientSecret 只有空白", { clientSecret: "   " }, "The client secret can't be empty"],
    // Secret upper bound; NUL / lone surrogate in the three string fields.
    ["clientSecret 4097 字", { clientSecret: "s".repeat(4097) }, "The client secret can be at most 4096 characters."],
    ["clientSecret 含 NUL", { clientSecret: `s${NUL}s` }, "The client secret contains characters that can't be stored."],
    ["clientSecret 含落單代理", { clientSecret: `s${LONE}s` }, "The client secret contains characters that can't be stored."],
    ["client id 含 NUL", { clientId: `c${NUL}c` }, "The client ID contains characters that can't be stored."],
    ["client id 含落單代理", { clientId: `c${LONE}c` }, "The client ID contains characters that can't be stored."],
    ["issuer 含 NUL", { issuerUrl: `https://idp.example.com/${NUL}` }, "The issuer URL contains characters that can't be stored."],
    ["issuer 含落單代理", { issuerUrl: `https://idp.example.com/${LONE}` }, "The issuer URL contains characters that can't be stored."],
    ["不認得的範本", { template: "github" }, "Invalid request body."],
    ["多一個欄位（strict）", { enabled: true }, "Invalid request body."],
  ])("POST with invalid input -> 400 invalid_body + English message, no new row in the DB: %s", async (_name, patch, message) => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, ...patch } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "invalid_body", message: expect.stringContaining(message) } });
    expect(await db.select().from(authProviders)).toHaveLength(0);
  });

  it("surrounding whitespace is trimmed before storing (display name, issuer, client id)", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, displayName: "  Corp  ", issuerUrl: " https://idp.example.com ", clientId: " knotebook " } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ displayName: "Corp", issuerUrl: "https://idp.example.com", clientId: "knotebook" });
  });

  it("whitespace around clientSecret is stored as-is (no trim; the decrypted value equals the one sent)", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, clientSecret: "  padded secret \t" } });
    expect(res.statusCode).toBe(201);
    const row = await providerRow(db, res.json().id);
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("  padded secret \t");
  });

  it("a display name of 40 emoji can be stored (counted in code points, consistent with the CHECK's char_length)", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, displayName: "😀".repeat(40) } });
    expect(res.statusCode).toBe(201);
  });

  it("POST id is generated by the server (an id in the body is rejected by strict)", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, id: randomUUID() } });
    expect(res.statusCode).toBe(400);
  });
});
