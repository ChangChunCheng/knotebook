import { randomUUID } from "node:crypto";
import { setTimeout as realDelay } from "node:timers/promises";
import http from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { eq } from "drizzle-orm";
import { BUILTIN_ACTION_IDS, INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, freshLimiters, testConfig, signTestSession } from "./helpers.js";
import { aiActions, aiModels, aiProviders, notes, noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptApiKey } from "../src/ai/crypto.js";
import { createAiRuntime } from "../src/ai/runtime.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { INSTRUCT_GUARD_PROMPT, MARKUP_GUARD_PROMPT } from "../src/ai/instruct.js";

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(db: Db) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({ email: `user-${Math.random().toString(36).slice(2)}@example.com`, displayName: "Test User", passwordHash })
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

async function insertAction(db: Db, overrides: Partial<typeof aiActions.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiActions)
    .values({
      name: overrides.name ?? "Test Action",
      systemPrompt: overrides.systemPrompt ?? "You are a helpful assistant.",
      userTemplate: overrides.userTemplate ?? "{{text}}",
      modelId: overrides.modelId ?? null,
      applyMode: overrides.applyMode ?? "direct",
      sortOrder: overrides.sortOrder ?? 0,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

interface NoteAccess {
  ownerId: string;
  ownerCookie: string;
  editorId: string;
  editorCookie: string;
  viewerId: string;
  viewerCookie: string;
  noteId: string;
}

async function setupNoteAccess(db: Db): Promise<NoteAccess> {
  const owner = await insertUser(db);
  const editor = await insertUser(db);
  const viewer = await insertUser(db);
  const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning({ id: notes.id });
  await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
  await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });
  return {
    ownerId: owner.id,
    ownerCookie: await cookieFor(owner.id),
    editorId: editor.id,
    editorCookie: await cookieFor(editor.id),
    viewerId: viewer.id,
    viewerCookie: await cookieFor(viewer.id),
    noteId: note.id,
  };
}

/** All limiters get production defaults; only `ai` can be overridden - for 429 tests with a small quota, without affecting other tests. */
function limitersWithAi(ai: FixedWindowLimiter) {
  return freshLimiters({ ai });
}

interface FakeUpstream {
  baseUrl: string;
  calls: number;
  requestBodies: Array<{ model?: string; messages?: Array<{ role: string; content: string }> }>;
  /** Whether the latest connection was cut before the full response was written (detected via close/aborted of `req`/`res`). */
  lastAborted: boolean;
}

/** Real local http server as fake upstream: `app.inject()` can't intercept outbound requests (our server code does a real `fetch()`);
 * same harness convention as `admin-ai.test.ts`. */
async function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, state: FakeUpstream) => void
): Promise<FakeUpstream> {
  const state: FakeUpstream = { baseUrl: "", calls: 0, requestBodies: [], lastAborted: false };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("aborted", () => {
      state.lastAborted = true;
    });
    res.on("close", () => {
      if (!res.writableEnded) state.lastAborted = true;
    });
    req.on("end", () => {
      try {
        state.requestBodies.push(JSON.parse(raw));
      } catch {
        // The app always sends JSON; the catch only keeps a bad body from skipping the handler.
      }
      handler(req, res, state);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream 取不到 TCP 位址");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  return state;
}

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

function eventSequence(body: string): string[] {
  return [...body.matchAll(/^event: (\w+)$/gm)].map(m => m[1]!);
}

describe("POST /api/ai - authorization matrix", () => {
  it("not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: "00000000-0000-0000-0000-000000000000", text: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("non-uuid action_id/note_id -> 400 (not 500)", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { action_id: "not-a-uuid", note_id: "also-not-a-uuid", text: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("note not permitted (including a nonexistent note) -> 404", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: "00000000-0000-0000-0000-000000000000", text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("viewer -> 403", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.viewerCookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });
});

describe("POST /api/ai - action/model resolution", () => {
  it("action doesn't exist -> 404", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("action exists but disabled -> 404", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const action = await insertAction(db, { enabled: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("zero providers -> 503 ai_not_configured", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const action = await insertAction(db); // modelId null, and zero providers/models site-wide
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ai_not_configured");
  });

  it("degraded provider -> 503 provider_unavailable, upstream not called", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end("data: [DONE]\n\n");
    });
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(fakeUpstream.calls).toBe(0);
  });

  it("anthropic provider without key -> 503 provider_unavailable and NOT added to the degraded set (independent pre-stream check)", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { type: "anthropic", baseUrl: "https://api.anthropic.example", apiKeyEncrypted: null });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("apiKey decryption fails -> 503 provider_unavailable and added to the degraded set", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    // Encrypt with a different appSecret to simulate "APP_SECRET changed, old ciphertext can't be decrypted": keyId won't match,
    // so whichever id the AAD binds to doesn't affect this assertion.
    const badId = randomUUID();
    const badCiphertext = encryptApiKey("a-completely-different-secret-".repeat(3), "sk-x", badId);
    const provider = await insertProvider(db, { id: badId, apiKeyEncrypted: badCiphertext });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(runtime.degraded.has(provider.id)).toBe(true);
  });

  it("429 (AI_LIMIT exhausted)", async () => {
    const smallAiLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: limitersWithAi(smallAiLimiter) });
    const access = await setupNoteAccess(db);
    const payload = { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" };

    const first = await app.inject({ method: "POST", url: "/api/ai", cookies: { [SESSION_COOKIE]: access.editorCookie }, payload });
    expect(first.statusCode).not.toBe(429); // the first call uses up the only quota (its result is 404, not what this test is about)

    const second = await app.inject({ method: "POST", url: "/api/ai", cookies: { [SESSION_COOKIE]: access.editorCookie }, payload });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");
  });
});

describe("POST /api/ai - normal streaming", () => {
  it("apiKey decrypts -> the plaintext key really reaches the upstream (issue #14: this path had zero coverage)", async () => {
    // `POST /api/ai` is the main consumer of the key, yet the only key states set in this file were "no key" and "deliberately undecryptable",
    // so if the new `decryptApiKey(..., resolved.provider.id)` argument were wrong (e.g. the model id), production would 503 every AI call
    // while the tests stayed green.
    let seenAuth: string | undefined;
    const fakeUpstream = await startFakeUpstream((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("ok"));
      res.end("data: [DONE]\n\n");
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const providerId = randomUUID();
    const provider = await insertProvider(db, {
      id: providerId,
      baseUrl: fakeUpstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-live-key", providerId),
    });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(seenAuth).toBe("Bearer sk-live-key");
  });

  it("normal stream to done: event order delta x N -> done", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("Hello"));
      res.write(sseDelta(", "));
      res.write(sseDelta("world!"));
      res.end("data: [DONE]\n\n");
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "sys prompt", userTemplate: "prefix {{text}} suffix" });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi there" },
    });

    expect(res.statusCode).toBe(200);
    // All four SSE headers are asserted (not just content-type): this line is easily deleted unnoticed when someone tidies headers,
    // especially x-accel-buffering (reverse proxies don't buffer, key to SSE timeliness).
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(eventSequence(res.body)).toEqual(["delta", "delta", "delta", "done"]);
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).not.toContain("event: error");

    // Body received upstream: system/user applied correctly (including {{text}} template substitution; system is preceded by the fixed columns notice).
    expect(fakeUpstream.requestBodies).toHaveLength(1);
    const sent = fakeUpstream.requestBodies[0]!;
    expect(sent.model).toBe(model.modelId);
    expect(sent.messages).toEqual([
      { role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nsys prompt` },
      { role: "user", content: "prefix hi there suffix" },
    ]);
  });

  it("after [DONE] the server still aborts even if the upstream doesn't close the connection itself (regression, prevents socket leaks)", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("ok"));
      res.write("data: [DONE]\n\n");
      // Deliberately don't call res.end(): simulates a lenient upstream that sends [DONE] but never hangs up,
      // forcing the question of whether the route's `finally` `handle.abort()` really asks to close the connection.
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(eventSequence(res.body)).toEqual(["delta", "done"]); // normal finish, unaffected by the upstream leaving the connection open

    // Even though the client request completed long ago, the upstream connection should be aborted by us (`handle.abort()`) shortly,
    // not left hanging forever - `lastAborted` reuses the existing fake upstream "cut before fully written" semantics
    // (here: "closed without res.end() being called").
    await realDelay(300);
    expect(fakeUpstream.lastAborted).toBe(true);
  });

  it("upstream 5xx -> SSE error event, fixed message text without the fake upstream body's sentinel string", async () => {
    const sentinel = "SENTINEL-DO-NOT-LEAK-9f3a";
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(sentinel);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });

    expect(res.statusCode).toBe(200); // after hijack it is always 200 + SSE; errors travel as events, not HTTP status
    expect(eventSequence(res.body)).toEqual(["error"]);
    expect(res.body).toContain("The request to the AI provider failed.");
    expect(res.body).not.toContain(sentinel);
  });

  it("after PATCHing an action's systemPrompt the next call takes effect immediately (no cache guard)", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "v1 prompt" });

    const first = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(first.statusCode).toBe(200);

    await db.update(aiActions).set({ systemPrompt: "v2 prompt — 改過了" }).where(eq(aiActions.id, action.id));

    const second = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(second.statusCode).toBe(200);

    expect(fakeUpstream.requestBodies).toHaveLength(2);
    expect(fakeUpstream.requestBodies[0]!.messages?.[0]).toEqual({ role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nv1 prompt` });
    expect(fakeUpstream.requestBodies[1]!.messages?.[0]).toEqual({ role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nv2 prompt — 改過了` });
  });

  it("client disconnecting midway -> fake upstream sees an abort", async () => {
    let releaseUpstream: (() => void) | undefined;
    const upstreamHeld = new Promise<void>(resolve => (releaseUpstream = resolve));
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("first-chunk"));
      // Deliberately don't end: hold the connection until the test aborts the client side, then observe whether the server detects the abort.
      void upstreamHeld;
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    await app.listen({ port: 0, host: "127.0.0.1" });
    onTestFinished(() => app.close());
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("app.listen 後取不到 TCP 位址");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const cookieHeader = `${SESSION_COOKIE}=${access.editorCookie}`;
    const controller = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/api/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ action_id: action.id, note_id: access.noteId, text: "hi" }),
      signal: controller.signal,
    });

    const res = await fetchPromise;
    const reader = res.body!.getReader();
    await reader.read(); // make sure at least the first delta arrived, i.e. the client is really connected to the stream

    controller.abort(); // simulate client disconnect midway
    await reader.cancel().catch(() => {});

    await realDelay(300);
    expect(fakeUpstream.lastAborted).toBe(true);
    releaseUpstream?.();
  });

  // No per-test timeout; the global testTimeout (vitest.config.ts, 120 s) applies: a per-test timeout would also cover buildTestApp (DB creation) and seeding,
  // which time out falsely on a busy machine. "The injected 400 ms is wired through" is guarded instead by a wall-clock bound on the idle phase only (20 s vs the production default 60 s).
  it(
    "idle timeout: short timeout after the fake upstream stops emitting deltas -> SSE error (real time, see the aiIdleTimeoutMs test hook)",
    async () => {
      const fakeUpstream = await startFakeUpstream((_req, res) => {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseDelta("only-one-chunk-then-silence"));
        // Then deliberately emit no more deltas and don't res.end(): simulates a stuck upstream, forcing the idle timeout branch.
      });
      // The idle timeout is injectable via `BuildAppOptions.aiIdleTimeoutMs` (see app.ts / routes/ai.ts) and given a short **real** value here;
      // `vi.useFakeTimers` is deliberately avoided: fake timers combined with real SSE I/O (the fake upstream is a real `http.createServer`, the app does a real `fetch()`)
      // hung in CI at `startFakeUpstream`'s `onTestFinished` server.close() until the 180 s hook timeout, after the test body had finished (the SSE connection never got closed).
      // The idle timer fires through its real `setTimeout`, with no fake clock involved.
      const { app, db } = await buildTestApp({}, { aiIdleTimeoutMs: 400 });
      const access = await setupNoteAccess(db);
      const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
      const model = await insertModel(db, provider.id);
      const action = await insertAction(db, { modelId: model.id });

      // `payloadAsStream: true` (light-my-request): the `app.inject()` promise resolves as soon as the handler's `raw.writeHead()` runs
      // (right after hijack), without waiting for the whole response.
      const res = await app.inject({
        method: "POST",
        url: "/api/ai",
        cookies: { [SESSION_COOKIE]: access.editorCookie },
        payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
        payloadAsStream: true,
      });
      expect(res.statusCode).toBe(200);

      const stream = res.stream();
      let body = "";
      let deltaSeen = false;
      let resolveFirstDelta: (() => void) | undefined;
      const firstDelta = new Promise<void>(resolve => {
        resolveFirstDelta = resolve;
      });
      const streamEnded = new Promise<void>(resolve => stream.once("end", resolve));
      // Accumulate manually with stream.on("data") instead of the more obvious `for await...of` + `break`:
      // breaking mid-iteration triggers the iterator's return(), which destroy()s the stream and cuts the SSE connection too early.
      stream.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (!deltaSeen && eventSequence(body).includes("delta")) {
          deltaSeen = true;
          resolveFirstDelta?.();
        }
      });

      // Wait until at least one full delta event has arrived (poll actual data, no fixed sleep): the handler's for-await loop calls resetIdleTimer
      // on every iteration, so receiving the first delta means the idle timer is armed.
      await firstDelta;
      const idleStart = Date.now();

      // No fake clock - just wait for real time (400 ms idle timeout plus some scheduling slack): the error event + raw.end() after the idle timer fires
      // arrive naturally, and the stream's 'end' event means the connection is closed.
      await streamEnded;
      // Only the span "delta received -> connection closed" is measured: if the injected 400 ms reaches the route it is far below the bound; if not (falling back to
      // IDLE_TIMEOUT_MS 60 s in routes/ai.ts) it waits the full 60 s -> red. The 20 s bound is far from both (same design as ./lock-timeout-bound.ts).
      expect(Date.now() - idleStart).toBeLessThan(20_000);
      expect(eventSequence(body)).toEqual(["delta", "error"]);
      expect(body).toContain("The request to the AI provider failed.");
    }
  );
});

describe("POST /api/ai - gate consistency, three cases (shares resolveActionModel with GET /api/ai/actions)", () => {
  it("first model created disabled -> GET list and POST both judge it unavailable", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { enabled: false });
    const action = await insertAction(db); // modelId null, fallback candidates empty (the only model is disabled)

    const getRes = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getRes.json().actions.map((a: { id: string }) => a.id)).not.toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(503);
    expect(postRes.json().error.code).toBe("ai_not_configured");
  });

  it("PATCH disabling the default model -> GET list and POST go from available to unavailable", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id, { isDefault: true });
    const action = await insertAction(db); // modelId null, hits the model through the isDefault fallback

    const getBefore = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getBefore.json().actions.map((a: { id: string }) => a.id)).toContain(action.id);

    const admin = await insertUser(db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const adminCookie = await cookieFor(admin.id);
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${model.id}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const getAfter = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getAfter.json().actions.map((a: { id: string }) => a.id)).not.toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(503);
    expect(postRes.json().error.code).toBe("ai_not_configured");
  });

  it("DELETE of the default model while another enabled model remains -> GET list and POST fall back successfully", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("fallback ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const defaultModel = await insertModel(db, provider.id, { modelId: "default-model", isDefault: true });
    const fallbackModel = await insertModel(db, provider.id, { modelId: "fallback-model", isDefault: false });
    const action = await insertAction(db); // modelId null, hits through the fallback ordering

    const admin = await insertUser(db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const adminCookie = await cookieFor(admin.id);
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/admin/ai/models/${defaultModel.id}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(deleteRes.statusCode).toBe(204);

    const getAfter = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getAfter.json().actions.map((a: { id: string }) => a.id)).toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(200);
    expect(eventSequence(postRes.body)).toEqual(["delta", "done"]);
    expect(fakeUpstream.requestBodies[0]!.model).toBe(fallbackModel.modelId);
  });
});

/**
 * issue #53: openai_compatible allows no key (a legitimate state for local vLLM/Ollama, so pre-stream must not treat it as an error),
 * but #46 makes "models attached, key cleared" easy to reach (any base_url change gets there): the upstream then answers 401/403
 * and the user sees an unrelated "AI service returned an error".
 *
 * Fix: only when the upstream explicitly returns an auth error AND the provider has no stored key, map the SSE error code to provider_unavailable
 * (the web i18n text for that code asks the admin to re-enter the API key). A key that exists but is rejected upstream (revoked/invalid) stays upstream_error.
 */
describe("POST /api/ai - openai_compatible without key hitting an upstream auth error (issue #53)", () => {
  async function run(upstreamStatus: number, providerOverrides: Partial<typeof aiProviders.$inferInsert>) {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "missing api key" } }));
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl, ...providerOverrides });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(200); // always 200 after hijack; errors travel as SSE events
    expect(eventSequence(res.body)).toEqual(["error"]);
    // The invariant "upstream body never leaks" must hold on **both** error exits (the existing sentinel test only drives 500 and so only covers
    // the upstream_error exit): the fake upstream body carries a sentinel string that must not appear in the SSE response whether or not it is mapped.
    expect(res.body).not.toContain("missing api key");
    return res.body;
  }

  it("no key + upstream 401 -> SSE error code is provider_unavailable (not upstream_error)", async () => {
    const body = await run(401, { apiKeyEncrypted: null });
    expect(body).toContain("provider_unavailable");
    expect(body).not.toContain("upstream_error");
  });

  it("no key + upstream 403 -> mapped to provider_unavailable too", async () => {
    const body = await run(403, { apiKeyEncrypted: null });
    expect(body).toContain("provider_unavailable");
    expect(body).not.toContain("upstream_error");
  });

  it("with a key + upstream 401 -> stays upstream_error (an invalid key is a different situation, must not mislead as not configured)", async () => {
    const providerId = randomUUID();
    const body = await run(401, {
      id: providerId,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-revoked-key", providerId),
    });
    expect(body).toContain("upstream_error");
    expect(body).not.toContain("provider_unavailable");
  });

  it("no key + upstream 500 -> stays upstream_error (only auth errors are mapped)", async () => {
    const body = await run(500, { apiKeyEncrypted: null });
    expect(body).toContain("upstream_error");
    expect(body).not.toContain("provider_unavailable");
  });
});

describe("POST /api/ai - #263 Instruct field matrix (400 before streaming, ahead of the role check and throttling)", () => {
  // Deliberately a note the user has no permission on: if the 400 came after resolveRole these cases would become 404.
  const NO_ACCESS_NOTE = "11111111-2222-4333-8444-555555555555";
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Instruct 缺 instruction", { action_id: INSTRUCT_ACTION_ID }],
    ["Instruct instruction 為空字串", { action_id: INSTRUCT_ACTION_ID, instruction: "" }],
    ["Instruct instruction 只有空白（含全形空白）", { action_id: INSTRUCT_ACTION_ID, instruction: " 　\t" }],
    ["Instruct instruction trim 後 501 code point", { action_id: INSTRUCT_ACTION_ID, instruction: `  ${"字".repeat(501)}  ` }],
    ["Instruct focus 2001 code point", { action_id: INSTRUCT_ACTION_ID, instruction: "改短", focus: "😀".repeat(2001) }],
    ["非 Instruct 帶 instruction（空字串也算帶）", { action_id: REWRITE_ACTION_ID, instruction: "" }],
    ["非 Instruct 只帶 focus（空字串也算帶）", { action_id: REWRITE_ACTION_ID, focus: "" }],
    ["大寫的 Instruct id 缺 instruction（小寫化後同樣走 Instruct 規則）", { action_id: INSTRUCT_ACTION_ID.toUpperCase() }],
  ];
  for (const [name, extra] of cases) {
    it(`${name} -> 400 invalid_body (400 comes first even when the note is not permitted)`, async () => {
      const { app, db } = await buildTestApp();
      const user = await insertUser(db);
      const res = await app.inject({
        method: "POST",
        url: "/api/ai",
        cookies: { [SESSION_COOKIE]: await cookieFor(user.id) },
        payload: { note_id: NO_ACCESS_NOTE, text: "hi", ...extra },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    });
  }

  it("Instruct 400s don't consume throttle quota: with limit 1, two 400s first, the third takes the quota (404: action doesn't exist), the fourth is 429", async () => {
    // Throttling comes after resolveRole (routes/ai.ts), so a note with edit permission is needed for the request to reach consume.
    const smallAiLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: limitersWithAi(smallAiLimiter) });
    const access = await setupNoteAccess(db);
    const bad = { action_id: INSTRUCT_ACTION_ID, note_id: access.noteId, text: "hi" };
    const ok = { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" };
    const send = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/ai", cookies: { [SESSION_COOKIE]: access.editorCookie }, payload });

    const statuses = [(await send(bad)).statusCode, (await send(bad)).statusCode, (await send(ok)).statusCode, (await send(ok)).statusCode];
    expect(statuses).toEqual([400, 400, 404, 429]);
  });

  it("Instruct: instruction 1..500 + focus of 2000 emoji -> stream 200 (not 400)", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    await insertModel(db, provider.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: INSTRUCT_ACTION_ID, note_id: access.noteId, text: "hi", instruction: "😀".repeat(500), focus: "😀".repeat(2000) },
    });
    expect(res.statusCode).toBe(200);
    expect(eventSequence(res.body)).toEqual(["delta", "done"]);
  });
});

describe("POST /api/ai - #263 assembly (fixed markers and guard)", () => {
  async function instructRun(payload: Record<string, unknown>, before?: (db: Db) => Promise<void>) {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    await insertModel(db, provider.id);
    if (before) await before(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { note_id: access.noteId, ...payload },
    });
    return { res, db, sent: fakeUpstream.requestBodies };
  }

  it("Instruct: user = default template with the three markers filled in order (instruction uses the trimmed value); system = fixed notice + blank line + guard + blank line + action prompt", async () => {
    const { res, db, sent } = await instructRun({
      action_id: INSTRUCT_ACTION_ID,
      text: "第一段\n\n第二段",
      instruction: "  改成條列  ",
      focus: "第二段",
    });
    const [instruct] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(sent).toHaveLength(1); // precondition: the upstream really received one request (otherwise reading sent[0] below would be a TypeError)
    expect(sent[0]!.messages).toEqual([
      { role: "system", content: `${MARKUP_GUARD_PROMPT}\n\n${INSTRUCT_GUARD_PROMPT}\n\n${instruct!.systemPrompt}` },
      { role: "user", content: "<instruction>\n改成條列\n</instruction>\n<selected>\n第二段\n</selected>\n<text>\n第一段\n\n第二段\n</text>" },
    ]);
    expect(res.statusCode).toBe(200);
  });

  it("Instruct without focus -> <selected></selected>", async () => {
    const { sent } = await instructRun({ action_id: INSTRUCT_ACTION_ID, text: "body", instruction: "x" });
    expect(sent).toHaveLength(1); // precondition: the upstream really received one request (otherwise reading sent[0] below would be a TypeError)
    expect(sent[0]!.messages?.[1]).toEqual({ role: "user", content: "<instruction>\nx\n</instruction>\n<selected></selected>\n<text>\nbody\n</text>" });
  });

  it("Instruct template edited by the admin: the route still wraps the markers, the template only decides order and the words in between", async () => {
    const { sent } = await instructRun({ action_id: INSTRUCT_ACTION_ID, text: "body", instruction: "x" }, async (db) => {
      await db.update(aiActions).set({ userTemplate: "B:{{text}} A:{{instruction}}" }).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    });
    expect(sent).toHaveLength(1); // precondition: the upstream really received one request (otherwise reading sent[0] below would be a TypeError)
    expect(sent[0]!.messages?.[1]?.content).toBe("B:<text>\nbody\n</text> A:<instruction>\nx\n</instruction>");
  });

  it("uppercase Instruct id: markers still wrapped, guard still prepended (lowercased before judging the DB id)", async () => {
    const { sent } = await instructRun({ action_id: INSTRUCT_ACTION_ID.toUpperCase(), text: "body", instruction: "x" });
    expect(sent).toHaveLength(1); // precondition: the upstream really received one request (otherwise reading sent[0] below would be a TypeError)
    expect(sent[0]!.messages?.[0]?.content.startsWith(`${MARKUP_GUARD_PROMPT}\n\n${INSTRUCT_GUARD_PROMPT}\n\n`)).toBe(true);
    expect(sent[0]!.messages?.[1]?.content).toContain("<text>\nbody\n</text>");
  });

  it("quick action: system = fixed notice + blank line + action prompt (no Instruct guard prepended), text substituted bare, {{instruction}}/{{focus}} substituted with an empty string", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "quick sp", userTemplate: "[{{instruction}}|{{focus}}|{{text}}]" });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(fakeUpstream.requestBodies[0]!.messages).toEqual([
      { role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nquick sp` },
      { role: "user", content: "[||hi]" },
    ]);
    expect(res.statusCode).toBe(200);
  });
});

// MARKUP_GUARD_PROMPT is prepended by the server at the very front of every action's system prompt;
// an admin editing systemPrompt in the DB (even to an empty string) can't remove it.
describe("POST /api/ai - fixed notice for columns and sizes", () => {
  async function upstreamApp() {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const send = async (actionId: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/ai",
        cookies: { [SESSION_COOKIE]: access.editorCookie },
        payload: { action_id: actionId, note_id: access.noteId, text: "hi" },
      });
      expect(res.statusCode).toBe(200);
      expect(eventSequence(res.body)).toEqual(["delta", "done"]);
    };
    return { db, model, send, sent: fakeUpstream.requestBodies };
  }

  it("admin changing systemPrompt, before and after and to an empty string: system always starts with the fixed notice; with an empty string system is just the fixed notice", async () => {
    const { db, model, send, sent } = await upstreamApp();
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "v1 prompt" });
    await send(action.id);
    await db.update(aiActions).set({ systemPrompt: "v2 只要翻譯" }).where(eq(aiActions.id, action.id));
    await send(action.id);
    // The admin API is min(1) and can't send an empty string; the DB column allows it - defensive case
    await db.update(aiActions).set({ systemPrompt: "" }).where(eq(aiActions.id, action.id));
    await send(action.id);
    expect(sent).toHaveLength(3);
    expect(sent.map(b => b.messages?.[0])).toEqual([
      { role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nv1 prompt` },
      { role: "system", content: `${MARKUP_GUARD_PROMPT}\n\nv2 只要翻譯` },
      { role: "system", content: MARKUP_GUARD_PROMPT },
    ]);
  });

  it("the four builtin quick actions (seeded ids) each send once: system is always fixed notice + blank line + that action's systemPrompt in the DB", async () => {
    const { db, send, sent } = await upstreamApp();
    const quickIds = BUILTIN_ACTION_IDS.filter(id => id !== INSTRUCT_ACTION_ID);
    expect(quickIds).toHaveLength(4);
    for (const id of quickIds) await send(id);
    const rows = await db.select().from(aiActions);
    const promptOf = (id: string) => rows.find(r => r.id === id)!.systemPrompt;
    expect(sent).toHaveLength(4);
    quickIds.forEach((id, i) => {
      expect(promptOf(id)).not.toBe("");
      expect(sent[i]!.messages?.[0]).toEqual({ role: "system", content: `${MARKUP_GUARD_PROMPT}\n\n${promptOf(id)}` });
    });
  });

  // In the anthropic branch system is the top-level `system` of the request body (`upstream.ts` streamAnthropic), not messages[0];
  // both branches share one opts today, and this case goes red if someone splits them.
  it("anthropic provider: the request body `system` is also fixed notice + blank line + action prompt", async () => {
    const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(
        ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "model-a", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
          ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
          ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
          ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
          ev("message_stop", { type: "message_stop" }),
      );
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const providerId = randomUUID();
    const provider = await insertProvider(db, {
      id: providerId,
      type: "anthropic",
      baseUrl: fakeUpstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ant-key", providerId),
    });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "anthropic sp" });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeUpstream.requestBodies).toHaveLength(1);
    expect((fakeUpstream.requestBodies[0] as { system?: unknown }).system).toBe(`${MARKUP_GUARD_PROMPT}\n\nanthropic sp`);
    expect(eventSequence(res.body)).toEqual(["delta", "done"]);
  });
});
