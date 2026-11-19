import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { aiActions, aiModels, aiProviders, notes } from "../src/db/schema.js";
import { createAiRuntime, selfCheckAiKeys } from "../src/ai/runtime.js";
import type { Db } from "../src/db/index.js";
import { encryptApiKey } from "../src/ai/crypto.js";
import { testConfig } from "./helpers.js";
import { adminApp } from "./helpers/admin-auth.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { OidcUnavailableError, probeOidcIssuer } from "../src/auth/oidc-client.js";

// Unexpected DB errors reach pino through the global error handler. drizzle 0.44's DrizzleQueryError embeds the whole SQL and params in its message and as properties:
// provider writes leak api_key_encrypted ct/iv/tag and a base_url that may carry `user:pass@`; action writes leak the full system prompt.
// A NUL character triggers a real pg error (22021, not any known unique/FK violation), so the real drizzle error shape is exercised.
const NUL = String.fromCodePoint(0);
/** In pino JSON lines a jsonb key appears as `\"ct\"` inside the message string and as `"ct"` inside objects; match both. */
const SEALED_KEY = /\\*"(?:ct|iv|tag|keyId)\\*"/;
const BASE_PASS = "base-url-password-marker";
const SECRET_HOST = "secret-host-marker.example.com";
const PROMPT_MARKER = "system-prompt-marker";
const MODEL_MARKER = "model-id-marker";
const REDACTED_SUFFIX = "時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
/** How DrizzleQueryError params reach the JSON log: `params: …` in the message (drizzle appends a newline plus `params: ${params}` after the SQL)
 * and the enumerable property serialized as `"params":`. Only these two shapes are matched, not the bare word, to avoid false reds from legitimate occurrences elsewhere. */
const PARAMS_LEAK = /params: |"params"\s*:/; // no \b: JSON escapes newlines as `\n`, so the char before `params` is n and \b would miss it

/** A local port we hold but nobody listens on: connecting always gives ECONNREFUSED, and no server using listen(0) can be handed it before the test ends (#255).
 * Not "listen(0), close, then connect": the released port gets reused by another test file and answers 404 instead of refusing.
 * Approach: pick a just-released port P, occupy it by connecting to a server of our own with localPort=P (no listener on P),
 * then connect to P once to confirm it is really refused (loopback behaviour differs across environments, so it is not assumed). */
const portReleases: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of portReleases.splice(0)) await release();
});
async function holdRefusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const holder = net.createServer(sock => sock.on("error", () => {}));
    await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
    const probeSrv = net.createServer();
    await new Promise<void>(resolve => probeSrv.listen(0, "127.0.0.1", resolve));
    const port = (probeSrv.address() as { port: number }).port;
    await new Promise<void>(resolve => probeSrv.close(() => resolve()));
    const holderPort = (holder.address() as { port: number }).port;
    const client = net.connect({ host: "127.0.0.1", port: holderPort, localPort: port });
    client.on("error", () => {});
    const release = async () => {
      client.destroy();
      await new Promise<void>(resolve => holder.close(() => resolve()));
    };
    const held = await new Promise<boolean>(resolve => {
      client.once("connect", () => resolve(true));
      client.once("error", () => resolve(false));
    });
    if (held) {
      const refused = await new Promise<boolean>(resolve => {
        const probe = net.connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 2_000);
        probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
        probe.once("error", err => { clearTimeout(timer); resolve((err as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
      });
      if (refused) {
        portReleases.push(release);
        return port;
      }
    }
    await release();
  }
  throw new Error("找不到會被拒絕的本機埠");
}

function logged(): { out: string[]; options: { logger: { level: string; stream: { write(chunk: string): void } } } } {
  const out: string[] = [];
  return { out, options: { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } } };
}

function parseLines(out: string[]): Array<Record<string, unknown>> {
  return out
    .join("")
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

async function insertProvider(db: Db, baseUrl = "https://api.example.com/v1") {
  const id = randomUUID();
  const [row] = await db
    .insert(aiProviders)
    .values({ id, name: "P", type: "openai_compatible", baseUrl, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-seed", id) })
    .returning();
  return row!;
}

async function insertModel(db: Db, providerId: string) {
  const [row] = await db.insert(aiModels).values({ providerId, modelId: "m", displayName: "M", purpose: "chat" }).returning();
  return row!;
}

async function insertAction(db: Db) {
  const [row] = await db
    .insert(aiActions)
    .values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct" })
    .returning();
  return row!;
}

type Case = {
  name: string;
  context: string;
  request: (db: Db) => Promise<{ method: "POST" | "PATCH"; url: string; payload: object }>;
  /** Sensitive fragments this route carries in params; none may appear anywhere in the log. */
  markers: string[];
  sealed: boolean;
};

const CASES: Case[] = [
  {
    name: "POST /providers",
    context: "建立 AI provider",
    request: async () => ({
      method: "POST",
      url: "/api/admin/ai/providers",
      // A base URL with user:pass@ is rejected with 400 at the entry and never reaches the DB; put the marker in the query instead (base_url still goes whole into params, so the assertion still discriminates).
      payload: { name: `x${NUL}`, type: "openai_compatible", baseUrl: `https://${SECRET_HOST}/v1?k=${BASE_PASS}`, apiKey: "sk-leak-me-not" },
    }),
    markers: [BASE_PASS, SECRET_HOST, "sk-leak-me-not"],
    sealed: true,
  },
  {
    name: "PATCH /providers/:id",
    context: "修改 AI provider",
    request: async db => {
      const p = await insertProvider(db);
      return {
        method: "PATCH",
        url: `/api/admin/ai/providers/${p.id}`,
        payload: { name: `x${NUL}`, baseUrl: `https://${SECRET_HOST}/v1?k=${BASE_PASS}`, apiKey: "sk-leak-me-not" },
      };
    },
    markers: [BASE_PASS, SECRET_HOST, "sk-leak-me-not"],
    sealed: true,
  },
  {
    name: "POST /models",
    context: "建立 AI model",
    request: async db => {
      const p = await insertProvider(db);
      return { method: "POST", url: "/api/admin/ai/models", payload: { providerId: p.id, modelId: MODEL_MARKER, displayName: `x${NUL}` } };
    },
    markers: [MODEL_MARKER],
    sealed: false,
  },
  {
    name: "PATCH /models/:id",
    context: "修改 AI model",
    request: async db => {
      const m = await insertModel(db, (await insertProvider(db)).id);
      return { method: "PATCH", url: `/api/admin/ai/models/${m.id}`, payload: { modelId: MODEL_MARKER, displayName: `x${NUL}` } };
    },
    markers: [MODEL_MARKER],
    sealed: false,
  },
  {
    name: "POST /actions",
    context: "建立 AI 動作",
    request: async () => ({
      method: "POST",
      url: "/api/admin/ai/actions",
      payload: { name: `x${NUL}`, systemPrompt: PROMPT_MARKER, userTemplate: "{{text}}", applyMode: "direct" },
    }),
    markers: [PROMPT_MARKER],
    sealed: false,
  },
  {
    name: "PATCH /actions/:id",
    context: "修改 AI 動作",
    request: async db => {
      const a = await insertAction(db);
      return { method: "PATCH", url: `/api/admin/ai/actions/${a.id}`, payload: { name: `x${NUL}`, systemPrompt: PROMPT_MARKER } };
    },
    markers: [PROMPT_MARKER],
    sealed: false,
  },
];

describe("admin AI writes hitting an unexpected DB error: 500 internal, log has no params/ciphertext/base_url/prompt", () => {
  it("precondition: when the same error is thrown unchanged, DrizzleQueryError's message does carry base_url and ciphertext (otherwise the checks below measure nothing)", async () => {
    const { db } = await adminApp();
    const id = randomUUID();
    const err = await db
      .insert(aiProviders)
      .values({ id, name: `x${NUL}`, type: "openai_compatible", baseUrl: `https://user:${BASE_PASS}@${SECRET_HOST}/v1`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "k", id) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DrizzleQueryError);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("22021");
    expect((err as Error).message).toContain(BASE_PASS);
    expect(JSON.stringify({ msg: (err as Error).message })).toMatch(SEALED_KEY);
  });

  it.each(CASES)("$name: 500 internal; redacted line logs {code 22021, constraint null, context}; whole log has no sensitive fragment", async c => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const req = await c.request(db);
    const res = await app.inject({ ...req, cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });

    const lines = parseLines(out);
    const hits = lines.filter(l => l.msg === `${c.context}${REDACTED_SUFFIX}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 50, code: "22021", context: c.context });
    expect(hits[0]).toHaveProperty("constraint", null);
    expect(hits[0]).not.toHaveProperty("name");

    const text = out.join("");
    expect(text).toContain("unhandled error");
    expect(text).not.toContain("Failed query");
    expect(text).not.toMatch(PARAMS_LEAK);
    for (const m of c.markers) expect(text).not.toContain(m);
    if (c.sealed) expect(text).not.toMatch(SEALED_KEY);
  });
});

describe("POST /providers/:id/test connection failure log has no credentials from base_url", () => {
  const MSG = "AI provider 測試連線失敗（逾時或網路錯誤）";

  it("base_url with user:pass@ -> 502; log only records errName/target/urlHasCredentials, no password", async () => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await insertProvider(db, `http://user:${BASE_PASS}@127.0.0.1:9/v1?k=query-secret-marker`);
    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId: p.id, errName: "TypeError", urlHasCredentials: true, target: "http://127.0.0.1:9/v1" });
    expect(hits[0]).not.toHaveProperty("err");

    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("connection refused without credentials -> log still keeps debuggable info (causeCode ECONNREFUSED)", async () => {
    const port = await holdRefusedPort(); // not :9 or similar ports that fetch treats as bad ports

    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await insertProvider(db, `http://127.0.0.1:${port}/v1`);
    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "TypeError", causeCode: "ECONNREFUSED", urlHasCredentials: false, target: `http://127.0.0.1:${port}/v1/models` });
  });
});

describe("POST /api/ai upstream failure log has no credentials from base_url (any user who can trigger an AI action can make this line appear)", () => {
  const MSG = "ai upstream failed";

  async function aiSetup(provider: { type: "openai_compatible" | "anthropic"; baseUrl: string; apiKey?: string }) {
    const { out, options } = logged();
    const { app, db, admin, cookies } = await adminApp({}, options);
    const id = randomUUID();
    await db.insert(aiProviders).values({
      id,
      name: "P",
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEncrypted: provider.apiKey !== undefined ? encryptApiKey(testConfig.appSecret, provider.apiKey, id) : null,
    });
    const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
    const [action] = await db
      .insert(aiActions)
      .values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id })
      .returning();
    const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
    const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
    return { out, res, providerId: id };
  }

  it.each(["openai_compatible", "anthropic"] as const)("%s: base_url with user:pass@ -> SSE error; log only records a summary, no password or query", async type => {
    const { out, res, providerId } = await aiSetup({ type, baseUrl: `http://user:${BASE_PASS}@127.0.0.1:9/v1?k=query-secret-marker`, apiKey: "sk-ai-key" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId, urlHasCredentials: true, target: "http://127.0.0.1:9/v1" });
    // openai_compatible: fetch throws a TypeError directly; anthropic: the SDK wraps it in APIConnectionError (`.name` is "Error", so constructor.name is used),
    // with the same TypeError as cause.
    expect(hits[0]).toMatchObject(type === "anthropic" ? { errName: "APIConnectionError", causeName: "TypeError" } : { errName: "TypeError" });
    expect(hits[0]).not.toHaveProperty("err");

    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("upstream non-2xx (UpstreamError) -> log still keeps status and the truncated upstreamBody", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream-body-marker");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { out } = await aiSetup({ type: "openai_compatible", baseUrl: `http://127.0.0.1:${port}/v1` });
      const hits = parseLines(out).filter(l => l.msg === MSG);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ errName: "UpstreamError", status: 500, upstreamBody: "upstream-body-marker", urlHasCredentials: false });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("startup v1->v2 ciphertext upgrade write failure: log has no new ciphertext", () => {
  it("UPDATE hits an unexpected DB error -> redacted line {code P0001, context} plus the original warn line (no err); whole log has no ct/iv/tag/params", async () => {
    const { db } = await adminApp();
    const id = randomUUID();
    // Hand-built v1 ciphertext (format before issue #14: no AAD); the upgrade applies to a v1 that decrypts with the current APP_SECRET.
    const key = createHash("sha256").update(`${testConfig.appSecret}:ai-key`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("sk-legacy", "utf8"), cipher.final()]);
    await db.insert(aiProviders).values({
      id,
      name: "Legacy",
      type: "openai_compatible",
      baseUrl: "http://localhost:9",
      apiKeyEncrypted: {
        v: 1,
        keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      },
    });
    // Fail only the UPDATE (SQLSTATE P0001, not any known constraint) so the real drizzle error shape is exercised.
    await db.execute(sql.raw("create function kb_test_fail_ai_update() returns trigger language plpgsql as $$ begin raise exception 'forced test failure'; end $$"));
    await db.execute(sql.raw("create trigger kb_test_fail_ai_update before update on ai_providers for each row execute function kb_test_fail_ai_update()"));

    const out: string[] = [];
    const log = pino({ level: "info" }, { write: (chunk: string) => void out.push(chunk) });
    await selfCheckAiKeys(db, testConfig.appSecret, createAiRuntime(), log);

    const lines = parseLines(out);
    const redacted = lines.filter(l => l.msg === `升級 AI provider 密文${REDACTED_SUFFIX}`);
    expect(redacted).toHaveLength(1);
    expect(redacted[0]).toMatchObject({ level: 50, code: "P0001", context: "升級 AI provider 密文" });
    const warn = lines.filter(l => typeof l.msg === "string" && l.msg.startsWith("AI provider API key 密文升級為 v2 失敗"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 40, providerId: id });
    expect(warn[0]).not.toHaveProperty("err");
    expect(lines.find(l => l.msg === "AI provider API key 密文升級掃描完成")).toMatchObject({ upgraded: 0, remaining: 1 });

    const text = out.join("");
    expect(text).not.toMatch(SEALED_KEY);
    expect(text).not.toContain("Failed query");
    expect(text).not.toMatch(PARAMS_LEAK);
  });
});

describe("anthropic unreachable (no credentials): log summary distinguishes error kind and underlying code", () => {
  it("closed local port -> errName APIConnectionError, causeCode ECONNREFUSED (in cause.cause)", async () => {
    const port = await holdRefusedPort();

    const { out, options } = logged();
    const { app, db, admin, cookies } = await adminApp({}, options);
    const id = randomUUID();
    await db.insert(aiProviders).values({ id, name: "P", type: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-a", id) });
    const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
    const [action] = await db.insert(aiActions).values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id }).returning();
    const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
    const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
    expect(res.body).toContain("event: error");

    const hits = parseLines(out).filter(l => l.msg === "ai upstream failed");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "APIConnectionError", causeName: "TypeError", causeCode: "ECONNREFUSED", urlHasCredentials: false });
  }, 60_000);
});

describe("OIDC discovery failure: with user:pass@ in issuer, error message and log have no password (/login triggers this without signing in)", () => {
  const ISSUER = `http://user:${BASE_PASS}@127.0.0.1:9/realms/x?k=query-secret-marker`;

  it("probeOidcIssuer: OidcUnavailableError message has only safeTarget and does not chain the underlying message; only a name/code summary of the underlying is kept", async () => {
    const err = await probeOidcIssuer(ISSUER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcUnavailableError);
    expect((err as Error).message).toBe("OIDC discovery 失敗（issuer=http://127.0.0.1:9/realms/x）");
    expect((err as OidcUnavailableError).underlying).toMatchObject({ errName: "TypeError" });
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(BASE_PASS);
  });

  it("GET /api/auth/oidc/login/:id -> 302 oidc_unavailable (response unchanged); log line records reason/underlying, no password or query", async () => {
    const { out, options } = logged();
    const { app, db } = await adminApp({}, options);
    const p = await seedAuthProvider(db, { issuerUrl: ISSUER });
    const res = await app.inject({ method: "GET", url: `/api/auth/oidc/login/${p.id}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");

    const hits = parseLines(out).filter(l => l.msg === "OIDC discovery 不可用，導回登入頁");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId: p.id, errName: "OidcUnavailableError", reason: "OIDC discovery 失敗（issuer=http://127.0.0.1:9/realms/x）", underlying: { errName: "TypeError" } });
    expect(hits[0]).not.toHaveProperty("err");
    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("POST /api/auth/oidc/link/:id -> 503 oidc_unavailable (response unchanged); log has no password", async () => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await seedAuthProvider(db, { issuerUrl: ISSUER });
    const res = await app.inject({ method: "POST", url: `/api/auth/oidc/link/${p.id}`, cookies, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "oidc_unavailable", message: "The sign-in service is unavailable right now. Try again later." } });

    const hits = parseLines(out).filter(l => l.msg === "手動連結起點：discovery 不可用");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "OidcUnavailableError", underlying: { errName: "TypeError" } });
    expect(out.join("")).not.toContain(BASE_PASS);
  });
});

describe("anthropic upstream non-2xx: log records status and truncated response body like openai", () => {
  it("400 JSON body -> errName BadRequestError, status 400, upstreamBody contains the upstream message", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json", "request-id": "req-marker" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "anthropic-body-marker" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { out, options } = logged();
      const { app, db, admin, cookies } = await adminApp({}, options);
      const id = randomUUID();
      await db.insert(aiProviders).values({ id, name: "P", type: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-a", id) });
      const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
      const [action] = await db.insert(aiActions).values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id }).returning();
      const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
      const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
      expect(res.body).toContain("event: error");
      expect(res.body).not.toContain("anthropic-body-marker");

      const hits = parseLines(out).filter(l => l.msg === "ai upstream failed");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ errName: "BadRequestError", status: 400, requestId: "req-marker" });
      expect(hits[0]!.upstreamBody).toContain("anthropic-body-marker");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
