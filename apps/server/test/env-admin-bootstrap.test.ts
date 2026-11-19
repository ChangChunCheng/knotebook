import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildApp } from "../src/app.js";
import { freshDb, freshUploadsDir, testConfig } from "./helpers.js";
import { UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { instanceSetup, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createAiRuntime } from "../src/ai/runtime.js";
import { SiteLimits } from "../src/site-limits/store.js";

/**
 * Dedicated harness for the integration tests of the `ADMIN_EMAIL`/`ADMIN_PASSWORD` env bootstrap (`initializeInstance` is the only path to initialize an instance): it doesn't go through
 * `buildTestApp()` - that helper deliberately doesn't call `initializeInstance` (see its description); here an order-dependent assembly is needed: run `initializeInstance` with an envAdmin
 * on a db first, then build the app on the same db, which is more direct by hand than bolting it onto the shared helper, and doesn't affect other tests. `limiters` isn't passed, so `buildApp`'s
 * built-in production defaults apply (same basis as buildTestApp without overrides; no need for a fresh instance per test since every `it` here has a fresh db/app).
 */
async function buildAppWithEnvAdmin(envAdmin?: { email: string; password: string }) {
  const { db } = await freshDb();
  await initializeInstance(db, envAdmin);
  const gate = new UserGate(db);
  const app = buildApp(
    {
      config: testConfig,
      db,
      // #397: calls `buildApp` directly instead of through the helpers - uses the read-only SiteLimits that doesn't touch the DB.
      siteLimits: SiteLimits.defaults({ machine: testConfig.machine }),
      gate,
      throttle: new LoginThrottle(),
      collabHooks: noopCollabHooks,
      uploadsDir: freshUploadsDir(),
      ai: createAiRuntime(),
    },
    { logger: false }
  );
  return { app, db };
}

const ENV_ADMIN = { email: "boss@example.com", password: "correct-horse-battery" };

describe("ADMIN_EMAIL/ADMIN_PASSWORD env bootstrap admin", () => {
  it("empty DB + both envs -> after startup that account can log in, isAdmin, mustChangePassword=false (#187: the env admin isn't forced to change password)", async () => {
    const { app, db } = await buildAppWithEnvAdmin(ENV_ADMIN);

    const [dbUser] = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(dbUser).toMatchObject({ email: ENV_ADMIN.email, displayName: "boss", isAdmin: true, mustChangePassword: false });
    expect(dbUser.passwordHash).toBeTruthy();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ENV_ADMIN.email, password: ENV_ADMIN.password },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json()).toMatchObject({ email: ENV_ADMIN.email, isAdmin: true, mustChangePassword: false });

    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ isAdmin: true, mustChangePassword: false });

    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
  });

  it("an env admin after login isn't blocked by the 'must change password first' 403: POST /api/auth/tokens -> 201 (a flagged account gets 403)", async () => {
    const { app } = await buildAppWithEnvAdmin(ENV_ADMIN);
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ENV_ADMIN.email, password: ENV_ADMIN.password },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/tokens",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "bootstrap-admin-token", scope: "notes:read", expiresInDays: null },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty("token");
  });

  it("uppercase ADMIN_EMAIL -> stored lowercase in the DB (single funnel)", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, { email: "BOSS-UPPER@Example.COM", password: "correct-horse-battery" });

    const [dbUser] = await db.select().from(users).where(eq(users.email, "boss-upper@example.com"));
    expect(dbUser).toBeDefined();
    expect(dbUser.email).toBe("boss-upper@example.com");
  });

  it("already-initialized DB (existing admin) + both envs -> env fully ignored, no new account created, existing account unchanged", async () => {
    const { db } = await freshDb();
    await db.insert(instanceSetup).values({ singleton: true });
    const existing = await db
      .insert(users)
      .values({
        email: "existing-owner@example.com",
        passwordHash: await hashPassword("existing-password-here"),
        displayName: "Existing Owner",
        isAdmin: true,
      })
      .returning();

    await initializeInstance(db, ENV_ADMIN);

    const envUserRows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(envUserRows).toHaveLength(0);

    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]).toMatchObject({ id: existing[0]!.id, email: "existing-owner@example.com" });
  });

  it("startup retry (running initializeInstance again on the same db with the same envAdmin) doesn't create a second admin", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, ENV_ADMIN);
    const afterFirst = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterFirst).toHaveLength(1);

    // Simulates "the process restarts and init runs again": instance_setup is already done, so the second call should be a straight no-op
    // that never touches the bootstrap logic.
    await initializeInstance(db, ENV_ADMIN);

    const afterSecond = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
  });

  it("concurrent startup attempts (two initializeInstance with the same envAdmin on the same db at once) -> only one admin is created", async () => {
    const { db } = await freshDb();

    await Promise.all([initializeInstance(db, ENV_ADMIN), initializeInstance(db, ENV_ADMIN)]);

    const rows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(rows).toHaveLength(1);
    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
  });

  it("not initialized and no envAdmin -> throws an actionable message", async () => {
    const { db } = await freshDb(); // freshDb returns {db, pool, close} - same destructuring convention as gate.test.ts
    await expect(initializeInstance(db)).rejects.toThrow(/ADMIN_EMAIL/);
    expect(await db.select().from(instanceSetup)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
