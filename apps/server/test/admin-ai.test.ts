import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { onTestFinished } from "vitest";
import http from "node:http";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { BUILTIN_ACTION_IDS, INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig, signTestSession } from "./helpers.js";
import { aiActions, aiModels, aiProviders, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { decryptApiKey, encryptApiKey } from "../src/ai/crypto.js";
import { createAiRuntime } from "../src/ai/runtime.js";

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(db: Db, overrides: Partial<{ email: string; isAdmin: boolean }> = {}) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: "Test User",
      isAdmin: overrides.isAdmin ?? false,
      passwordHash,
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

async function insertProvider(db: Db, overrides: Partial<typeof aiProviders.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiProviders)
    .values({
      // The ciphertext is bound to providerId (issue #14): a caller that wants to insert existing ciphertext must have the id first,
      // so this accepts `overrides.id`, like production's `POST /api/admin/ai/providers`.
      id: overrides.id ?? randomUUID(),
      name: overrides.name ?? "Test Provider",
      type: overrides.type ?? "openai_compatible",
      baseUrl: overrides.baseUrl ?? "http://localhost:9",
      apiKeyEncrypted: overrides.apiKeyEncrypted ?? null,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

async function insertModel(db: Db, providerId: string, overrides: Partial<typeof aiModels.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiModels)
    .values({
      providerId,
      modelId: overrides.modelId ?? "model-a",
      displayName: overrides.displayName ?? "Model A",
      purpose: "chat",
      isDefault: overrides.isDefault ?? false,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

interface FakeUpstream {
  baseUrl: string;
  calls: number;
}

/** Real local http server as fake upstream: the test-connection endpoint does a real `fetch()`, `app.inject()` can't intercept outbound requests,
 * and only a real connection can verify "zero calls" and "body not leaked". */
async function startFakeUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const state: FakeUpstream = { baseUrl: "", calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream 取不到 TCP 位址");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));
  return state;
}

describe("requireAdmin guard: every admin AI endpoint is 403 for non-admin, 401 when not signed in", () => {
  const endpoints: Array<{ name: string; url: (id: string) => string; method: "GET" | "POST" | "PATCH" | "DELETE" }> = [
    { name: "GET providers", method: "GET", url: () => "/api/admin/ai/providers" },
    { name: "POST providers", method: "POST", url: () => "/api/admin/ai/providers" },
    { name: "PATCH providers/:id", method: "PATCH", url: id => `/api/admin/ai/providers/${id}` },
    { name: "DELETE providers/:id", method: "DELETE", url: id => `/api/admin/ai/providers/${id}` },
    { name: "POST providers/:id/test", method: "POST", url: id => `/api/admin/ai/providers/${id}/test` },
    { name: "GET models", method: "GET", url: () => "/api/admin/ai/models" },
    { name: "POST models", method: "POST", url: () => "/api/admin/ai/models" },
    { name: "PATCH models/:id", method: "PATCH", url: id => `/api/admin/ai/models/${id}` },
    { name: "DELETE models/:id", method: "DELETE", url: id => `/api/admin/ai/models/${id}` },
    { name: "GET actions", method: "GET", url: () => "/api/admin/ai/actions" },
    { name: "POST actions", method: "POST", url: () => "/api/admin/ai/actions" },
    { name: "PATCH actions/:id", method: "PATCH", url: id => `/api/admin/ai/actions/${id}` },
    { name: "DELETE actions/:id", method: "DELETE", url: id => `/api/admin/ai/actions/${id}` },
  ];

  for (const ep of endpoints) {
    it(`${ep.name}: non-admin -> 403`, async () => {
      const { app, db } = await buildTestApp();
      const nonAdmin = await insertUser(db, { email: `nonadmin-${ep.name}@example.com` });
      const cookie = await cookieFor(nonAdmin.id);
      const res = await app.inject({ method: ep.method, url: ep.url("00000000-0000-0000-0000-000000000000"), cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode).toBe(403);
    });

    it(`${ep.name}: not signed in -> 401`, async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({ method: ep.method, url: ep.url("00000000-0000-0000-0000-000000000000") });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("providers CRUD", () => {
  it("POST create (with apiKey) -> 201, hasKey=true; response never contains api_key_encrypted/ct/iv/tag/keyId", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p1@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/providers",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Ollama", type: "openai_compatible", baseUrl: "http://localhost:11434/v1", apiKey: "sk-test-123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "Ollama", type: "openai_compatible", baseUrl: "http://localhost:11434/v1", hasKey: true, degraded: false });
    expect(Object.keys(body).sort()).toEqual(["baseUrl", "createdAt", "degraded", "enabled", "hasKey", "id", "name", "type"].sort());

    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/api_key_encrypted|"ct"|"iv"|"tag"|"keyId"/);

    // The DB really holds the ciphertext (so it is the response that masks it, not a missing write).
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, body.id));
    expect(row.apiKeyEncrypted).not.toBeNull();
  });

  it("POST without apiKey -> hasKey=false", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p2@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/providers",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "No Key", type: "openai_compatible", baseUrl: "http://localhost:11434/v1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ hasKey: false });
  });

  it("GET list: response has no api_key_encrypted/ct even though the DB holds ciphertext", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p3@example.com" });
    const p1Id = randomUUID();
    await insertProvider(db, { id: p1Id, name: "P1", apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-abc", p1Id) });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/providers", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toMatch(/api_key_encrypted|"ct"|"iv"|"tag"|"keyId"/);
    expect(res.json().providers.find((p: { name: string }) => p.name === "P1")).toMatchObject({ hasKey: true });
  });

  it("PATCH with apiKey overwrite removes it from degraded (removed once the self-check succeeds, no restart needed)", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { apiKeyEncrypted: { v: 1, keyId: "deadbeef", iv: "aa", tag: "bb", ct: "cc" } });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { apiKey: "sk-new-valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true, degraded: false });
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("changing base_url (without a new key) invalidates the existing key: hasKey false, DB ciphertext really null (issue #46)", async () => {
    // `/test` and every AI call send the **plaintext** key to the host baseUrl points at, and baseUrl is only format-validated.
    // Without invalidation, any admin could change one plaintext field, press Test, and send the key to their own host.
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4c@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, { id, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-secret", id) });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "http://attacker.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: false, baseUrl: "http://attacker.example.com" });

    // DB-side assertion: not just the response's hasKey changed; the ciphertext itself is gone.
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(row!.apiKeyEncrypted).toBeNull();
    // With no key there can't be "undecryptable ciphertext", so degraded is cleared too (as in issue #17).
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("changing base_url + a new key in the same request -> the new key is used, not invalidated (new URL and key in one step)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4d@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, { id, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-old", id) });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "https://new.example.com", apiKey: "sk-brand-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(decryptApiKey(testConfig.appSecret, row!.apiKeyEncrypted!, provider.id)).toBe("sk-brand-new");
  });

  it("baseUrl sent with the **same value** (only renaming) -> key untouched", async () => {
    // The edit form sends baseUrl on every submit, so the check must be "differs from the old value", not "field present";
    // otherwise renaming once wipes the user's key.
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4e@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, {
      id,
      baseUrl: "https://api.example.com",
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-keep-me", id),
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "換個名字", baseUrl: "https://api.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true, name: "換個名字" });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(decryptApiKey(testConfig.appSecret, row!.apiKeyEncrypted!, provider.id)).toBe("sk-keep-me");
  });

  it("provider that never had a key, changing URL -> 200, hasKey still false, no error", async () => {
    // Self-hosted Ollama changing port: clearing is a no-op and must have no side effect.
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4f@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: "http://localhost:11434/v1", apiKeyEncrypted: null });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "http://localhost:11435/v1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: false, baseUrl: "http://localhost:11435/v1" });
  });

  it("changing the URL leaves an audit log whose message matches the docs verbatim (docs tell people to grep it)", async () => {
    // `docs/self-hosting.md` tells maintainers to `grep 'base URL'` and `docs/known-limitations.md` quotes this message verbatim
    // as "the trustworthy trace"; without a test pinning it, changing the message silently breaks both docs.
    const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
    const { app, db } = await buildTestApp(
      {},
      {
        logger: {
          level: "info",
          // pino write hook: collect only our own line, ignore the rest (fastify req/res).
          hooks: {
            logMethod(args: unknown[], method: (...a: unknown[]) => void) {
              const [obj, msg] = args as [Record<string, unknown>, string | undefined];
              if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
              method.apply(this, args as never[]);
            },
          },
        },
      }
    );
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4h@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, {
      id,
      // Simulate data that predates the new rule: base_url with userinfo + query (the entry now rejects it with 400, so write the DB directly).
      // `from` is read from this row; safeTarget must record only origin+pathname.
      baseUrl: "https://user:pass@evil.example.com/v1?k=secret",
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-x", id),
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "https://ok.example.com/v1" },
    });
    expect(res.statusCode).toBe(200);

    const line = lines.find(one => one.msg === "AI provider 的 base URL 被寫入");
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({
      providerId: provider.id,
      userId: admin.id,
      from: "https://evil.example.com/v1",
      to: "https://ok.example.com/v1",
      hasKeyAfter: false,
    });
    // Neither credentials nor query may appear in any field of that line.
    expect(JSON.stringify(line!.obj)).not.toContain("pass");
    expect(JSON.stringify(line!.obj)).not.toContain("secret");

    // The line must be logged even when the URL looks unchanged (the core of the fix): if the trigger regressed to "only when different from `existing`",
    // an attacker sending no-op PATCHes would, in the racing case, produce no line at all,
    // and the docs call that line the trustworthy trace, which is exactly the case it must catch.
    lines.length = 0;
    const again = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "https://ok.example.com/v1" },
    });
    expect(again.statusCode).toBe(200);
    expect(lines.some(one => one.msg === "AI provider 的 base URL 被寫入")).toBe(true);
  });

  it("concurrency: attacker's no-op PATCH queued after the victim's still can't steal the freshly entered key (TOCTOU regression pin)", async () => {
    // Past bypass: the handler SELECTed the old URL, then UPDATEd, with no transaction in between. The attacker keeps sending
    // `{baseUrl: EVIL}` (old value read as EVIL => judged unchanged => key not cleared, yet base_url = EVIL is written);
    // if one SELECT lands before the victim's "restore correct URL + re-enter key" UPDATE and its UPDATE after,
    // the final row is the attacker's URL + the victim's freshly entered key.
    //
    // The race window is not gambled on here (at the old code's 7% lower-bound hit rate, 12 rounds all missing has ~40% probability,
    // so the pin would miss its target regression 40% of the time). Instead the test holds the row lock itself to fix the order:
    // the attacker's UPDATE necessarily queues after the victim's commit. The old Node-side comparison necessarily misses in that
    // order, because its SELECT is not blocked by the row lock and reads the pre-write value.
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4g@example.com" });
    const cookie = await cookieFor(admin.id);
    const GOOD = "https://api.openai.com/v1";
    const EVIL = "http://evil.example.com/v1";

    const id = randomUUID();
    await insertProvider(db, { id, baseUrl: EVIL, apiKeyEncrypted: null });

    // A separate raw connection to the same test database (`buildTestApp` doesn't expose its pool).
    const [{ current_database: dbName }] = (
      await db.execute<{ current_database: string }>(sql`select current_database()`)
    ).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();

    try {
      await holder.query("begin");
      await holder.query("select 1 from ai_providers where id = $1 for update", [id]);

      // Attacker's request: the SELECT works (not blocked by the row lock, reads EVIL), the UPDATE blocks on the lock.
      const attacker = app.inject({
        method: "PATCH",
        url: `/api/admin/ai/providers/${id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { baseUrl: EVIL },
      });
      await new Promise(resolve => setTimeout(resolve, 500));

      // Proves the attacker's request really is blocked on the row lock: without this assertion, on a slow machine 500ms may not suffice and its SELECT
      // would run after the victim's commit => reads GOOD => judged changed => even the old code passes, and this pin stops testing its regression.
      // Being blocked by the lock itself proves the SELECT has already run.
      const pending = Symbol("pending");
      expect(await Promise.race([attacker, Promise.resolve(pending)])).toBe(pending);

      // Victim: restore the correct URL and re-enter the key (done inside the lock, so it necessarily commits first).
      await holder.query(
        `update ai_providers set base_url = $1, api_key_encrypted = $2::jsonb where id = $3`,
        [GOOD, JSON.stringify(encryptApiKey(testConfig.appSecret, "sk-victim-secret", id)), id]
      );
      await holder.query("commit");
      await attacker;
    } finally {
      await holder.end();
    }

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
    // The attacker's URL is written (they are allowed to change it), but the key must not survive:
    // the `case when` re-compares against the URL the victim just committed, so it necessarily clears it.
    expect(row!.baseUrl).toBe(EVIL);
    expect(row!.apiKeyEncrypted).toBeNull();
  });

  it("DELETE provider also removes it from degraded (otherwise a dirty state that would never be cleared)", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4b@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { apiKeyEncrypted: { v: 1, keyId: "deadbeef", iv: "aa", tag: "bb", ct: "cc" } });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(204);
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("PATCH without apiKey leaves ciphertext untouched (hasKey unchanged)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p5@example.com" });
    const cookie = await cookieFor(admin.id);
    const providerId = randomUUID();
    const encrypted = encryptApiKey(testConfig.appSecret, "sk-original", providerId);
    const provider = await insertProvider(db, { id: providerId, apiKeyEncrypted: encrypted });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Renamed", hasKey: true });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(row.apiKeyEncrypted).toEqual(encrypted);
  });

  it("PATCH nonexistent -> 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p6@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("baseUrl with credentials (user:pass@ or user@ only) -> POST/PATCH both 400 base_url_has_credentials, DB unchanged; normal URL accepted", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p-cred@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const [before] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));

    for (const bad of ["https://user:pass@example.com/v1", "https://user@example.com/v1", "https://:pass@example.com/v1"]) {
      const post = await app.inject({
        method: "POST",
        url: "/api/admin/ai/providers",
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { name: "Cred", type: "openai_compatible", baseUrl: bad },
      });
      expect(post.statusCode).toBe(400);
      expect(post.json()).toMatchObject({ error: { code: "base_url_has_credentials" } });
      expect(post.body).not.toContain("pass@");

      const patch = await app.inject({
        method: "PATCH",
        url: `/api/admin/ai/providers/${provider.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { baseUrl: bad },
      });
      expect(patch.statusCode).toBe(400);
      expect(patch.json()).toMatchObject({ error: { code: "base_url_has_credentials" } });
    }
    const [after] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(after.baseUrl).toBe(before.baseUrl);

    // An @ elsewhere in the URL (path/query) is not credentials; don't reject it.
    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/ai/providers",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Fine", type: "openai_compatible", baseUrl: "https://example.com/v1/@x?k=a@b" },
    });
    expect(ok.statusCode).toBe(201);
    const okPatch = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "http://localhost:11434/v1" },
    });
    expect(okPatch.statusCode).toBe(200);
  });

  it("malformed baseUrl (including credentials plus malformed) -> POST/PATCH both 400 invalid_body, not 500, and log has no password", async () => {
    const lines: unknown[] = [];
    const { app, db } = await buildTestApp(
      {},
      {
        logger: {
          level: "info",
          hooks: {
            logMethod(args: unknown[], method: (...a: unknown[]) => void) {
              // Collect only the error object (`err`) and message; the whole args carry the req object (including request body), which is not log output.
              const [obj, msg] = args as [{ err?: Error } | string, string | undefined];
              const err = typeof obj === "object" && obj !== null ? obj.err : undefined;
              lines.push({ msg, err: err ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : undefined });
              method.apply(this, args as never[]);
            },
          },
        },
      },
    );
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p-badurl@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    for (const bad of ["https://user:s3cretpw@ho st/v1", "not a url", "https://"]) {
      const post = await app.inject({
        method: "POST",
        url: "/api/admin/ai/providers",
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { name: "Bad", type: "openai_compatible", baseUrl: bad },
      });
      expect(post.statusCode).toBe(400);
      expect(post.json()).toMatchObject({ error: { code: "invalid_body" } });
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/admin/ai/providers/${provider.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { baseUrl: bad },
      });
      expect(patch.statusCode).toBe(400);
      expect(patch.json()).toMatchObject({ error: { code: "invalid_body" } });
    }
    expect(JSON.stringify(lines)).not.toContain("s3cretpw");
    expect(lines.length).toBeGreaterThan(0);
  });

  // Empty body `{}` has all fields optional; unfiltered, `.set({})` throws "No values to set"
  // synchronously in drizzle 0.44 and escapes the handler as a bare 500.
  it("PATCH empty body {} -> 400 invalid_body (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p9@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("DELETE -> 204; models cascade-delete; related actions.modelId SET NULL (DB assertion)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p7@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "Custom", systemPrompt: "sp", userTemplate: "{{text}}", modelId: model.id, applyMode: "direct", sortOrder: 99 })
      .returning();

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/providers/${provider.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);

    const [modelRow] = await db.select().from(aiModels).where(eq(aiModels.id, model.id));
    expect(modelRow).toBeUndefined();

    const [actionRow] = await db.select().from(aiActions).where(eq(aiActions.id, action.id));
    expect(actionRow.modelId).toBeNull();
  });

  it("DELETE nonexistent -> 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p8@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({ method: "DELETE", url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("POST /api/admin/ai/providers/:id/test", () => {
  it("degraded provider -> 503 provider_unavailable, upstream not called (fake upstream gets zero calls)", async () => {
    const runtime = createAiRuntime();
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t1@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });
    runtime.degraded.add(provider.id);

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(upstream.calls).toBe(0);
  });

  it("fake upstream 200 -> {ok:true}", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t2@example.com" });
    const cookie = await cookieFor(admin.id);
    const okId = randomUUID();
    const provider = await insertProvider(db, {
      id: okId,
      baseUrl: upstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ok", okId),
    });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(upstream.calls).toBe(1);
  });

  it("anthropic branch: hits /v1/models with x-api-key + anthropic-version, no authorization", async () => {
    const seen: { url?: string; headers?: http.IncomingHttpHeaders } = {};
    const upstream = await startFakeUpstream((req, res) => {
      seen.url = req.url;
      seen.headers = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t6@example.com" });
    const cookie = await cookieFor(admin.id);
    const antId = randomUUID();
    const provider = await insertProvider(db, {
      id: antId,
      type: "anthropic",
      baseUrl: upstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ant-test-key", antId),
    });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(seen.url).toBe("/v1/models");
    expect(seen.headers?.["x-api-key"]).toBe("sk-ant-test-key");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it("fake upstream 5xx -> error code upstream_error, body has no upstream content", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: "leaked-internal-detail-should-not-appear" }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t3@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });
    expect(res.body).not.toContain("leaked-internal-detail-should-not-appear");
  });

  // No per-test timeout; the global testTimeout (vitest.config.ts, 120 s) applies: this case must wait the full product-side AbortSignal.timeout(10_000),
  // plus buildTestApp (DB creation) and seeding; a hard-coded 15 s left ~5 s slack, and slow DB creation on a busy machine caused false reds.
  // "The upstream timeout is ~10 s" is guarded instead by bounding only the app.inject call (< 30 s): if the product became ~60 s it goes red, regardless of DB creation speed.
  it("upstream timeout (no response for >10s) -> upstream_error, body has no upstream content", async () => {
    const upstream = await startFakeUpstream(() => {
      // Deliberately never call res.end(): keep the connection hanging so AbortSignal.timeout(10_000) fires.
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t4@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });

    const t0 = Date.now();
    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });
  });

  it("nonexistent provider -> 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t5@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({ method: "POST", url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000/test", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("models CRUD", () => {
  it("POST purpose other than chat -> 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m1@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "m1", displayName: "M1", purpose: "embedding" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("isDefault is transactionally unique: setting a second default makes the first false", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m2@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const m1 = await insertModel(db, provider.id, { modelId: "m1", isDefault: true });
    const m2 = await insertModel(db, provider.id, { modelId: "m2", isDefault: false });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${m2.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isDefault: true });

    const [row1] = await db.select().from(aiModels).where(eq(aiModels.id, m1.id));
    expect(row1.isDefault).toBe(false);
  });

  // PATCH of a nonexistent id with `{isDefault:true}`: before the fix, the transaction first unconditionally unset other rows of the same purpose
  // and only then found the target missing, so a request with no target silently cleared the existing default preference before returning 404,
  // and the transaction still committed (a missing row is not an exception, no rollback). Required: the whole request has no effect,
  // 404, existing default untouched.
  it("PATCH nonexistent id + {isDefault:true} -> 404, existing default untouched (regression)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m7@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const existingDefault = await insertModel(db, provider.id, { modelId: "existing-default", isDefault: true });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/models/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });

    const [row] = await db.select().from(aiModels).where(eq(aiModels.id, existingDefault.id));
    expect(row.isDefault).toBe(true);
  });

  // models PATCH with empty body {} -> 400 (same reason as providers PATCH).
  it("PATCH empty body {} -> 400 invalid_body (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m8@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${model.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // Well-formed uuid that doesn't exist as providerId: verifies `isForeignKeyViolation` really handles the pg error wrapped by drizzle 0.44
  // (`DrizzleQueryError`, original error in `.cause`), not only a bare `DatabaseError` shape.
  it("POST with nonexistent providerId (valid uuid) -> 400 invalid_body (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m9@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: "00000000-0000-0000-0000-000000000000", modelId: "m1", displayName: "M1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("POST isDefault:true is transactionally unique: existing default is unset", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m3@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const existing = await insertModel(db, provider.id, { modelId: "existing", isDefault: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "new-default", displayName: "New Default", isDefault: true },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db.select().from(aiModels).where(eq(aiModels.id, existing.id));
    expect(row.isDefault).toBe(false);
  });

  it("duplicate (providerId, modelId) -> 409 model_taken", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m4@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { modelId: "dup-model" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "dup-model", displayName: "Dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "model_taken" } });
  });

  it("DELETE -> 204; nonexistent -> 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m5@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/models/${model.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);

    const resMissing = await app.inject({ method: "DELETE", url: `/api/admin/ai/models/${model.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(resMissing.statusCode).toBe(404);
  });

  it("GET list has the right shape", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m6@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { modelId: "shape-model" });

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/models", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const found = res.json().models.find((m: { modelId: string }) => m.modelId === "shape-model");
    expect(found).toMatchObject({ providerId: provider.id, displayName: "Model A", purpose: "chat", enabled: true });
  });
});

describe("actions CRUD", () => {
  it("GET list: builtin flag correct (builtin actions true, custom false)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a1@example.com" });
    const cookie = await cookieFor(admin.id);
    await db.insert(aiActions).values({ name: "Custom", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 100 });

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const rows: Array<{ id: string; builtin: boolean; name: string }> = res.json().actions;
    for (const id of BUILTIN_ACTION_IDS) {
      expect(rows.find(r => r.id === id)?.builtin).toBe(true);
    }
    expect(rows.find(r => r.name === "Custom")?.builtin).toBe(false);
  });

  it("#263: GET list carries kind (Instruct = instruct; builtin Rewrite and custom actions = quick)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-k1@example.com" });
    const cookie = await cookieFor(admin.id);
    await db.insert(aiActions).values({ name: "CustomKind", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 100 });

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    const rows: Array<{ id: string; name: string; kind: string }> = res.json().actions;
    expect(rows.find((r) => r.id === INSTRUCT_ACTION_ID)?.kind).toBe("instruct");
    expect(rows.find((r) => r.id === REWRITE_ACTION_ID)?.kind).toBe("quick");
    expect(rows.find((r) => r.name === "CustomKind")?.kind).toBe("quick");
    expect(res.statusCode).toBe(200);
  });

  it("POST userTemplate missing {{text}} -> 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a2@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Bad", systemPrompt: "sp", userTemplate: "no placeholder here", applyMode: "direct" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // Well-formed uuid that doesn't exist as modelId: same `isForeignKeyViolation` unwrapping as models POST, here for the actions table's other FK (`model_id`).
  it("POST with nonexistent modelId (valid uuid) -> 400 invalid_body (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a7@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {
        name: "Bad Model Ref",
        systemPrompt: "sp",
        userTemplate: "{{text}}",
        applyMode: "direct",
        modelId: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // actions PATCH with empty body {} -> 400 (same reason as providers/models PATCH).
  it("PATCH empty body {} -> 400 invalid_body (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a8@example.com" });
    const cookie = await cookieFor(admin.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "EmptyPatchTarget", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 1 })
      .returning();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("POST creates a custom action; custom action can be DELETEd", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a3@example.com" });
    const cookie = await cookieFor(admin.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "MyAction", systemPrompt: "sp", userTemplate: "{{text}} 請處理", applyMode: "preview", sortOrder: 5 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created).toMatchObject({ name: "MyAction", builtin: false, applyMode: "preview", sortOrder: 5 });

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/admin/ai/actions/${created.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(deleteRes.statusCode).toBe(204);

    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, created.id));
    expect(row).toBeUndefined();
  });

  it("DELETE builtin action -> 400 builtin_action, nothing deleted", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a4@example.com" });
    const cookie = await cookieFor(admin.id);
    const builtinId = BUILTIN_ACTION_IDS[0];

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/actions/${builtinId}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "builtin_action" } });

    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, builtinId));
    expect(row).toBeDefined();
  });

  it("PATCH sortOrder accepts integers; PATCH userTemplate missing {{text}} -> 400", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a5@example.com" });
    const cookie = await cookieFor(admin.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "PatchMe", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 1 })
      .returning();

    const okRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { sortOrder: 7 },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toMatchObject({ sortOrder: 7 });

    const badRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { userTemplate: "沒有佔位符" },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("PATCH nonexistent -> 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a6@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/actions/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { sortOrder: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("#263 PATCH Instruct applyMode direct -> 400 instruct_preview_only, DB unchanged; preview accepted", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-i1@example.com" });
    const cookie = await cookieFor(admin.id);
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/admin/ai/actions/${INSTRUCT_ACTION_ID}`, cookies: { [SESSION_COOKIE]: cookie }, payload });

    const bad = await patch({ applyMode: "direct" });
    expect(bad.json()).toMatchObject({ error: { code: "instruct_preview_only" } });
    expect(bad.statusCode).toBe(400);
    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(row?.applyMode).toBe("preview");
    expect((await patch({ applyMode: "preview" })).statusCode).toBe(200);
  });

  it("#263 PATCH Instruct userTemplate: missing {{instruction}} -> 400; missing {{text}} -> 400; both present, {{focus}} optional -> 200", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-i2@example.com" });
    const cookie = await cookieFor(admin.id);
    const patch = (userTemplate: string) =>
      app.inject({ method: "PATCH", url: `/api/admin/ai/actions/${INSTRUCT_ACTION_ID}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { userTemplate } });

    const noInstruction = await patch("{{text}} {{focus}}");
    expect(noInstruction.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(noInstruction.statusCode).toBe(400);
    const noText = await patch("{{instruction}} {{focus}}");
    expect(noText.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(noText.statusCode).toBe(400);
    const ok = await patch("Do: {{instruction}}\n{{text}}");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ userTemplate: "Do: {{instruction}}\n{{text}}", kind: "instruct" });
  });

  it("#263 Instruct with uppercase path id is restricted the same (path id is lowercased before comparison)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-i3@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${INSTRUCT_ACTION_ID.toUpperCase()}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { applyMode: "direct" },
    });
    expect(res.json()).toMatchObject({ error: { code: "instruct_preview_only" } });
  });

  it("#263 other actions are unaffected by Instruct rules: Rewrite to direct and template with only {{text}} accepted; DELETE Instruct -> 400 builtin_action", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-i4@example.com" });
    const cookie = await cookieFor(admin.id);
    const rewrite = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${REWRITE_ACTION_ID}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { applyMode: "direct", userTemplate: "{{text}}" },
    });
    expect(rewrite.statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: `/api/admin/ai/actions/${INSTRUCT_ACTION_ID}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(del.json()).toMatchObject({ error: { code: "builtin_action" } });
  });
});
