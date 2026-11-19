import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { BUILTIN_ACTION_IDS, INSTRUCT_ACTION_ID, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, signTestSession } from "./helpers.js";
import { aiActions, aiModels, aiProviders, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";

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
      // Aligned with the same-name helper in admin-ai/ai-sse: the ciphertext is bound to providerId (issue #14),
      // so a caller inserting existing ciphertext must have the id first.
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

describe("GET /api/ai/actions (regular session)", () => {
  it("not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/ai/actions" });
    expect(res.statusCode).toBe(401);
  });

  it("fresh instance (builtin five actions seeded but zero providers) -> {actions: []} - not configured = the feature doesn't exist", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);

    // The seed has really run (migrate calls seedAiActions at the end): the DB holds five builtin actions, but with zero providers resolution
    // fails for all, and the list must be empty - the existence of the seed must not leak.
    const [seeded] = await db.select().from(aiActions).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));
    expect(seeded).toBeDefined();

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actions: [] });
  });

  it("provider + enabled model (no default set) -> all five builtin actions appear (positive case of gate consistency)", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([...BUILTIN_ACTION_IDS].sort());
    for (const a of res.json().actions) {
      expect(Object.keys(a).sort()).toEqual(["applyMode", "id", "kind", "name"]);
    }
  });

  it("#263: kind - Instruct is instruct, the other builtin and custom actions are quick", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);
    const [custom] = await db
      .insert(aiActions)
      .values({ name: "Custom", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "preview", sortOrder: 9 })
      .returning();

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    const kinds = new Map((res.json().actions as Array<{ id: string; kind: string }>).map((a) => [a.id, a.kind]));
    expect(kinds.get(INSTRUCT_ACTION_ID)).toBe("instruct");
    for (const id of BUILTIN_ACTION_IDS.filter((x) => x !== INSTRUCT_ACTION_ID)) expect(kinds.get(id)).toBe("quick");
    expect(kinds.get(custom.id)).toBe("quick");
    expect(res.statusCode).toBe(200);
  });

  it("disabling the only usable model -> empty", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { enabled: false });

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actions: [] });
  });

  it("action.enabled=false -> not listed (even though the model resolves)", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);
    await db.update(aiActions).set({ enabled: false }).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(BUILTIN_ACTION_IDS[0]);
    expect(ids).toHaveLength(BUILTIN_ACTION_IDS.length - 1);
  });

  it("order is sortOrder, id: a custom action with a smaller sortOrder comes before builtin ones", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);
    const [custom] = await db
      .insert(aiActions)
      .values({ name: "First", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: -1 })
      .returning();

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().actions[0].id).toBe(custom.id);
  });

  it("positive fallback: the action's bound model is disabled but another enabled chat model exists -> the action still appears", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    const disabledModel = await insertModel(db, provider.id, { modelId: "disabled-one", enabled: false });
    await insertModel(db, provider.id, { modelId: "fallback-one" });
    await db.update(aiActions).set({ modelId: disabledModel.id }).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id);
    expect(ids).toContain(BUILTIN_ACTION_IDS[0]);
  });
});
