import { describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import { authProviders, siteSettings } from "../src/db/schema.js";
import { createOidcRuntimeRegistry, type OidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { openClientSecret, sealClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";
const NUL = String.fromCodePoint(0);

async function seedLive(db: Parameters<typeof seedAuthProvider>[0]) {
  return seedAuthProvider(db, { issuerUrl: ISS, resolvedIssuer: ISS, clientId: "client-a", clientSecret: "secret-a", enabled: true, configVersion: 3 });
}

function patch(app: Awaited<ReturnType<typeof adminApp>>["app"], cookies: Record<string, string>, id: string, payload: object) {
  return app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies, payload });
}

/** #299: a provider without client ID is created via POST (`seedAuthProvider` can't seed NULL). */
async function createWithoutClientId(app: Awaited<ReturnType<typeof adminApp>>["app"], cookies: Record<string, string>, withSecret: boolean): Promise<string> {
  const payload = { template: "oidc", displayName: "SSO", issuerUrl: ISS, ...(withSecret ? { clientSecret: "secret-a" } : {}) };
  const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("PATCH /api/admin/auth/providers/:id (#187)", () => {
  it("site admins only", async () => {
    const { app, db } = await adminApp();
    const p = await seedLive(db);
    await expectAdminOnly(app, db, "PATCH", `/api/admin/auth/providers/${p.id}`, { displayName: "x" });
  });

  it("changing issuer (no secret sent) -> secret and resolved_issuer cleared, disabled, version +1; response enabled=false, hasSecret=false", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://other.example.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ issuerUrl: "https://other.example.com", enabled: false, hasSecret: false, issuerResolved: false });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ clientSecretEncrypted: null, resolvedIssuer: null, enabled: false, configVersion: 4 });
  });

  it("issuer sent with the same value (the edit form always sends it) -> nothing cleared, not disabled, version unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: ISS, displayName: "Renamed" });
    expect(res.statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ displayName: "Renamed", resolvedIssuer: ISS, enabled: true, configVersion: 3 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("changing issuer + a new secret -> secret is the new value, resolved cleared, force-disabled, version +1", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://other.example.com", clientSecret: "secret-b", enabled: true });
    expect(res.statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ resolvedIssuer: null, enabled: false, configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-b");
  });

  it("secret only -> overwritten, version +1, enabled state and resolved_issuer unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    expect((await patch(app, cookies, p.id, { clientSecret: "secret-c" })).statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ enabled: true, resolvedIssuer: ISS, configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-c");
  });

  it("changing only client_id -> new value, version +1; sending the same value again -> version unchanged; secret never cleared", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { clientId: "client-b" });
    expect(await providerRow(db, p.id)).toMatchObject({ clientId: "client-b", configVersion: 4, enabled: true });
    await patch(app, cookies, p.id, { clientId: "client-b" });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ clientId: "client-b", configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("changing only display name/order/enabled -> version unchanged; PATCH without issuerUrl -> secret not cleared, not disabled", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { displayName: "Name 2", sortOrder: 5 });
    await patch(app, cookies, p.id, { enabled: false });
    await patch(app, cookies, p.id, { enabled: true });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ displayName: "Name 2", sortOrder: 5, enabled: true, resolvedIssuer: ISS, configVersion: 3 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("enabling a provider without secret -> 409 provider_secret_missing (DB CHECK), row unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: null, enabled: false });
    const res = await patch(app, cookies, p.id, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_secret_missing");
    expect((await providerRow(db, p.id))!.enabled).toBe(false);
  });

  it("(#299) enabling a provider with secret but no client ID -> 409 provider_client_id_missing, row unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const id = await createWithoutClientId(app, cookies, true);
    const res = await patch(app, cookies, id, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_client_id_missing");
    expect(await providerRow(db, id)).toMatchObject({ enabled: false, clientId: null, configVersion: 1 });
  });

  it("(#299) client ID and secret both missing -> 409 provider_client_id_missing (same-row CHECKs are reported in name alphabetical order), row unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const id = await createWithoutClientId(app, cookies, false);
    const res = await patch(app, cookies, id, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_client_id_missing");
    expect(await providerRow(db, id)).toMatchObject({ enabled: false, clientId: null, clientSecretEncrypted: null });
  });

  it("(#299) filling client ID and enabling in the same request -> 200, enabled true", async () => {
    const { app, db, cookies } = await adminApp();
    const id = await createWithoutClientId(app, cookies, true);
    const res = await patch(app, cookies, id, { clientId: "x", enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, clientId: "x" });
    expect(await providerRow(db, id)).toMatchObject({ enabled: true, clientId: "x" });
  });

  it("(#299) clientId: null -> 400 invalid_body, a stored client ID can't be cleared", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { clientId: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect(await providerRow(db, p.id)).toMatchObject({ clientId: "client-a", configVersion: 3 });
  });

  it("clientSecret empty string -> 400; empty body -> 400; nonexistent uuid/non-uuid -> 404 not_found", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    expect((await patch(app, cookies, p.id, { clientSecret: "" })).statusCode).toBe(400);
    expect((await patch(app, cookies, p.id, {})).statusCode).toBe(400);
    const missing = await patch(app, cookies, "00000000-0000-4000-8000-000000000000", { displayName: "x" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "No sign-in service with that id." } });
    expect((await patch(app, cookies, "not-a-uuid", { displayName: "x" })).statusCode).toBe(404);
    expect(await providerRow(db, p.id)).toMatchObject({ configVersion: 3 });
  });

  it("PATCH with invalid input -> 400, row unchanged: uppercase scheme, NUL display name, 41-character display name", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    for (const payload of [{ issuerUrl: "HTTPS://idp.example.com" }, { displayName: `a${NUL}` }, { displayName: "x".repeat(41) }]) {
      expect((await patch(app, cookies, p.id, payload)).statusCode).toBe(400);
    }
    expect(await providerRow(db, p.id)).toMatchObject({ issuerUrl: ISS, displayName: "SSO", configVersion: 3 });
  });

  it("PATCH with a malformed issuer plus credentials -> 400 invalid_body (not 500), row unchanged", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://user:pass@ho st/v1" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await providerRow(db, p.id)).toMatchObject({ issuerUrl: ISS, configVersion: 3 });
  });

  it("uppercase uuid path is equivalent to lowercase; registry.invalidate receives the lowercase id (called on every successful PATCH)", async () => {
    const invalidated: string[] = [];
    const inner = createOidcRuntimeRegistry();
    const registry: OidcRuntimeRegistry = { get: inner.get, probe: inner.probe, invalidate: id => { invalidated.push(id); inner.invalidate(id); } };
    const { app, db, cookies } = await adminApp({ oidcRegistry: registry });
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id.toUpperCase(), { displayName: "Upper" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(p.id);
    expect(invalidated).toEqual([p.id]);
    await patch(app, cookies, p.id, { enabled: true, clientId: "x" });
    expect(invalidated).toEqual([p.id, p.id]);
    await patch(app, cookies, p.id, { clientSecret: "" }); // 400: no invalidate
    expect(invalidated).toHaveLength(2);
  });

  it("audit log: one line whenever issuerUrl is sent (even if the value is the same); only origin+pathname is recorded; hasSecretAfter/enabledAfter come from the value the DB returns", async () => {
    const logs = captureLogs();
    const { app, db, cookies, admin } = await adminApp({}, logs.options);
    // Simulate data that predates the new rule: issuer with userinfo + query (the entry now rejects it with 400, so write the DB directly); `from` is read from this row.
    const p = await seedAuthProvider(db, { issuerUrl: "https://user:pass@idp.example.com/?k=secret", resolvedIssuer: ISS, clientId: "client-a", clientSecret: "secret-a", enabled: true, configVersion: 3 });
    await patch(app, cookies, p.id, { issuerUrl: "https://evil.example.com/realm?k=secret" });
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 被寫入");
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({ providerId: p.id, userId: admin.id, from: "https://idp.example.com/", to: "https://evil.example.com/realm", hasSecretAfter: false, enabledAfter: false });
    // Only origin+pathname is recorded: neither userinfo (user:pass@) nor query (?k=...) may appear in from/to (compare the values themselves, not the field names).
    for (const field of [line!.obj.from, line!.obj.to]) expect(String(field)).not.toMatch(/[?@]|pass/);
    logs.lines.length = 0;
    await patch(app, cookies, p.id, { issuerUrl: "https://evil.example.com/realm?k=secret" });
    expect(logs.lines.filter(l => l.msg === "登入服務的 issuer 被寫入")).toHaveLength(1);
    logs.lines.length = 0;
    await patch(app, cookies, p.id, { displayName: "no issuer" });
    expect(logs.lines.filter(l => l.msg === "登入服務的 issuer 被寫入")).toHaveLength(0);
  });

  it("changing to an http issuer -> one extra warn line", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { issuerUrl: "http://idp.lan" });
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 是明文 http");
    expect(line?.level).toBe("warn");
  });

  it("TOCTOU: attacker's no-op PATCH (issuer unchanged) queued after the victim's 'restore correct issuer + re-enter secret' still can't steal that secret", async () => {
    // Same approach as test/admin-ai.test.ts: another connection holds the row lock to fix the order instead of gambling on probability.
    const { app, db, cookies } = await adminApp();
    const EVIL = "https://evil.example.com";
    const GOOD = "https://idp.example.com";
    const p = await seedAuthProvider(db, { issuerUrl: EVIL, clientSecret: null, enabled: false });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from auth_providers where id = $1 for update", [p.id]);
      const attacker = patch(app, cookies, p.id, { issuerUrl: EVIL });
      expect(await waitForBlockedOrSettled(db.$client, attacker)).toBe("blocked");
      await holder.query("update auth_providers set issuer_url = $1, client_secret_encrypted = $2::jsonb where id = $3", [
        GOOD,
        JSON.stringify(sealClientSecret(testConfig.appSecret, p.id, "victim-secret")),
        p.id,
      ]);
      await holder.query("commit");
      expect((await attacker).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    const row = await providerRow(db, p.id);
    expect(row!.issuerUrl).toBe(EVIL);
    expect(row!.clientSecretEncrypted).toBeNull();
    expect(row!.enabled).toBe(false);
  });

  it("in-flight login: changing only the display name -> login completes normally; changing client id -> oidc_unavailable on return", async () => {
    for (const [change, expectedLocation] of [[{ displayName: "Renamed mid-flight" }, "/"], [{ clientId: "client-b" }, "/login?error=oidc_unavailable"]] as const) {
      const { app, db, idp, provider } = await buildOidcApp({ providers: [{ key: "a", issuerUrl: ISS }] });
      const admin = await seedUser(db, { isAdmin: true });
      const p = provider("a");
      idp("a").setNextLogin({ sub: `inflight-${Math.random()}`, email: `inflight-${Math.random()}@example.com`, name: "Inflight" });
      const loginRes = await app.inject({ method: "GET", url: `/api/auth/oidc/login/${p.id}` });
      expect(loginRes.statusCode).toBe(302);
      const { code, state } = idp("a").authorize(loginRes.headers.location as string);
      const stateCookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
      expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${p.id}`, cookies: await cookieOf(admin.id), payload: change })).statusCode).toBe(200);
      const callback = await app.inject({
        method: "GET",
        url: `/api/auth/oidc/callback/${p.id}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        cookies: { [OIDC_STATE_COOKIE]: stateCookie },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe(expectedLocation);
      const [row] = await db.select({ v: authProviders.configVersion }).from(authProviders).where(eq(authProviders.id, p.id));
      expect(row!.v).toBe("clientId" in change ? 2 : 1);
    }
  });
});

const AUTO_CREATE_LOG = "登入服務的自動建帳開關被變更";
const ISSUER_LOG = "登入服務的 issuer 被寫入";
const OTHER_ISS = "https://other.example.com";

describe("PATCH autoCreateEnabled", () => {
  it("PATCH {autoCreateEnabled} toggles it; configVersion untouched; the switch log is written only when the value changes", async () => {
    const logs = captureLogs();
    const { app, db, cookies, admin } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    const autoLines = () => logs.lines.filter(l => l.msg === AUTO_CREATE_LOG);
    const res = await patch(app, cookies, p.id, { autoCreateEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoCreateEnabled).toBe(false);
    expect(await providerRow(db, p.id)).toMatchObject({ autoCreateEnabled: false, configVersion: 3, enabled: true });
    expect(autoLines()).toHaveLength(1);
    expect(autoLines()[0]!.obj).toEqual({ providerId: p.id, userId: admin.id, autoCreateEnabled: false });
    expect((await patch(app, cookies, p.id, { autoCreateEnabled: false })).statusCode).toBe(200);
    expect(autoLines()).toHaveLength(1);
    expect((await patch(app, cookies, p.id, { displayName: "x" })).statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.autoCreateEnabled).toBe(false);
    // Off -> on is logged too (turning auto-create on is the event most worth recording).
    expect((await patch(app, cookies, p.id, { autoCreateEnabled: true })).statusCode).toBe(200);
    expect(autoLines()).toHaveLength(2);
    expect(autoLines()[1]!.obj).toEqual({ providerId: p.id, userId: admin.id, autoCreateEnabled: true });
  });

  it("when the DB password switch is off and the operator has no SSO identity, toggling auto-create still returns 200 (the self-lockout guard is not triggered); contrast: disabling under the same condition -> 409", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const res = await patch(app, cookies, p.id, { autoCreateEnabled: false });
    expect(res.statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.autoCreateEnabled).toBe(false);
    expect((await patch(app, cookies, p.id, { enabled: false })).statusCode).toBe(409);
  });

  it("site admins only", async () => {
    const { app, db } = await adminApp();
    const p = await seedLive(db);
    await expectAdminOnly(app, db, "PATCH", `/api/admin/auth/providers/${p.id}`, { autoCreateEnabled: true });
  });

  it("current value true, changing only issuer -> still true; issuer log carries autoCreateEnabledAfter: true; no switch log", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: OTHER_ISS });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoCreateEnabled).toBe(true);
    expect((await providerRow(db, p.id))!.autoCreateEnabled).toBe(true);
    const issuerLine = logs.lines.find(l => l.msg === ISSUER_LOG);
    expect(issuerLine!.obj).toMatchObject({ providerId: p.id, autoCreateEnabledAfter: true });
    expect(logs.lines.filter(l => l.msg === AUTO_CREATE_LOG)).toHaveLength(0);
  });

  it("current value true, changing issuer + autoCreateEnabled: false -> false; both log lines present, switch log first", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: OTHER_ISS, autoCreateEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoCreateEnabled).toBe(false);
    const autoIdx = logs.lines.findIndex(l => l.msg === AUTO_CREATE_LOG);
    const issuerIdx = logs.lines.findIndex(l => l.msg === ISSUER_LOG);
    expect(autoIdx).toBeGreaterThanOrEqual(0);
    expect(issuerIdx).toBeGreaterThan(autoIdx);
    expect(logs.lines[autoIdx]!.obj).toMatchObject({ autoCreateEnabled: false });
    expect(logs.lines[issuerIdx]!.obj).toMatchObject({ autoCreateEnabledAfter: false });
  });

  it("current value false, changing issuer + autoCreateEnabled: true -> true (with or without a secret)", async () => {
    for (const extra of [{}, { clientSecret: "new-secret" }]) {
      const { app, db, cookies } = await adminApp();
      const p = await seedAuthProvider(db, { issuerUrl: ISS, resolvedIssuer: ISS, clientId: "client-a", clientSecret: "secret-a", enabled: true, configVersion: 3, autoCreateEnabled: false });
      const res = await patch(app, cookies, p.id, { issuerUrl: OTHER_ISS, autoCreateEnabled: true, ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(200);
      expect(res.json().autoCreateEnabled, JSON.stringify(extra)).toBe(true);
      expect((await providerRow(db, p.id))!.autoCreateEnabled, JSON.stringify(extra)).toBe(true);
    }
  });
});

// If the statement writing the ciphertext column hits an unexpected DB error, the global error handler logs the whole err: drizzle 0.44's
// `DrizzleQueryError` puts params (including the jsonb ct/iv/tag) in the message and also as properties. A real trigger makes INSERT/UPDATE fail
// (SQLSTATE P0001, not any known CHECK/unique), so the real drizzle error shape is exercised instead of a fake object.
describe("unexpected DB error while writing the client secret: 500, log carries no ciphertext", () => {
  /** In pino JSON lines a jsonb key appears as `\"ct\"` inside the message string and as `"ct"` inside objects; match both. */
  const SEALED_KEY = /\\*"(?:ct|iv|tag|keyId)\\*"/;

  async function failProviderWrites(db: Parameters<typeof seedAuthProvider>[0]) {
    await db.execute(sql.raw("create function kb_test_fail_provider_write() returns trigger language plpgsql as $$ begin raise exception 'forced test failure'; end $$"));
    await db.execute(sql.raw("create trigger kb_test_fail_provider_write before insert or update or delete on auth_providers for each row execute function kb_test_fail_provider_write()"));
  }

  /** Context strings callers pass to `redactDbError`; they prefix the redacted log message. */
  const CONTEXT = { POST: "建立登入服務", PATCH: "修改登入服務", DELETE: "刪除登入服務" } as const;

  function redactLine(out: string[], context: string): Record<string, unknown> {
    const lines = out.join("").split("\n").filter(l => l.trim() !== "").map(l => JSON.parse(l) as Record<string, unknown>);
    const hits = lines.filter(l => l.msg === `${context}時發生非預期的資料庫錯誤（錯誤本體已遮蔽）`);
    expect(hits).toHaveLength(1);
    return hits[0]!;
  }

  it.each(["POST", "PATCH", "DELETE"] as const)("%s: 500 internal; whole log has no ct/iv/tag/keyId and no params; records {code, constraint, context}", async method => {
    const out: string[] = [];
    const { app, db, cookies } = await adminApp({}, { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } });
    // DELETE only removes disabled rows (an enabled one gets 409 first and never reaches the write statement).
    const p = method === "DELETE" ? await seedAuthProvider(db, { issuerUrl: ISS, clientId: "client-a", clientSecret: "secret-a", enabled: false }) : await seedLive(db);
    await failProviderWrites(db);

    // Precondition (otherwise this case measures nothing): when the same error is thrown unchanged, the message does carry the ciphertext, and SEALED_KEY matches its shape in the JSON log.
    const premise = await db
      .update(authProviders)
      .set({ clientSecretEncrypted: sealClientSecret(testConfig.appSecret, p.id, "premise") })
      .where(eq(authProviders.id, p.id))
      .catch((err: unknown) => err);
    expect(premise).toBeInstanceOf(DrizzleQueryError);
    expect((premise as Error).message).toContain('"ct"');
    expect(JSON.stringify({ msg: (premise as Error).message })).toMatch(SEALED_KEY);

    const res =
      method === "PATCH"
        ? await patch(app, cookies, p.id, { clientSecret: "leak-me-not" })
        : method === "DELETE"
          ? await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies })
          : await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { template: "oidc", displayName: "X", issuerUrl: ISS, clientId: "c", clientSecret: "leak-me-not" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });

    // The redacted line: code / constraint (the trigger's raise has no constraint -> null, but the key must exist) / context; pg errors don't log name.
    const line = redactLine(out, CONTEXT[method]);
    expect(line).toMatchObject({ level: 50, code: "P0001", context: CONTEXT[method] });
    expect(line).toHaveProperty("constraint", null);
    expect(line).not.toHaveProperty("name");

    const text = out.join("");
    expect(text).toContain("unhandled error");
    expect(text).not.toMatch(SEALED_KEY);
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("params");
    expect(text).not.toContain("leak-me-not");
  });

  it("non-pg error (transaction throws a plain Error): 500; the redacted line also records name, not message", async () => {
    const out: string[] = [];
    const { app, db, cookies } = await adminApp({}, { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } });
    const p = await seedLive(db);
    // Test hook: the route uses this db (buildTestApp returns deps.db); intercept only this one transaction.
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("boom"));
    const res = await patch(app, cookies, p.id, { displayName: "Renamed" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });

    const line = redactLine(out, CONTEXT.PATCH);
    expect(line).toMatchObject({ level: 50, code: null, constraint: null, name: "Error", context: CONTEXT.PATCH });
    expect(out.join("")).not.toContain("boom");
  });
});
