// Test hook route: registered only when config.testHooks is set (KNOTEBOOK_E2E_TEST_HOOKS=1 and PUBLIC_URL is loopback).
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { markPending } from "../src/collab/versions.js";
import { loadConfig } from "../src/config.js";
import { seedDoc } from "./copy-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { paraDoc, versionsOf } from "./version-helpers.js";

const ENV = { DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64) };
const ROUTE = "/api/admin/test/version-auto-wait";
async function put(app: FastifyInstance, who: string, payload: unknown) {
  return app.inject({ method: "PUT", url: ROUTE, cookies: await cookieOf(who), payload: payload as object });
}

describe("e2e test hook route", () => {
  it("env var not set -> the route does not exist (404)", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    expect((await put(app, admin.id, { seconds: 2 })).statusCode).toBe(404);
  });

  it("set but PUBLIC_URL is not loopback -> ignored: the route does not exist (404)", async () => {
    const config = loadConfig({ ...ENV, PUBLIC_URL: "https://notes.example.com", KNOTEBOOK_E2E_TEST_HOOKS: "1" });
    expect(config.testHooksIgnored).toBe(true);
    const { app, db } = await buildTestApp({ config });
    const admin = await seedUser(db, { isAdmin: true });
    expect((await put(app, admin.id, { seconds: 2 })).statusCode).toBe(404);
  });

  it("enabled: site admin only; strict { seconds: integer 1-3600 | null }; after 204 the scanner's X is overridden, null returns to the site setting", async () => {
    const config = loadConfig({ ...ENV, PUBLIC_URL: "http://localhost:3000", KNOTEBOOK_E2E_TEST_HOOKS: "1" });
    expect(config.testHooks).toBe(true);
    const ctx = await buildCollabTestApp({ config });
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const user = await seedUser(ctx.db);
    expect((await ctx.app.inject({ method: "PUT", url: ROUTE, payload: { seconds: 2 } })).statusCode).toBe(401);
    expect((await put(ctx.app, user.id, { seconds: 2 })).statusCode).toBe(403);
    for (const body of [{ seconds: 0 }, { seconds: 3601 }, { seconds: 1.5 }, { seconds: "2" }, {}, { seconds: 2, x: 1 }]) {
      const r = await put(ctx.app, admin.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    const seedPending = async (text: string) => {
      const n = await seedNote(ctx.db, { ownerId: admin.id });
      await seedDoc(ctx.db, n.id, paraDoc([text]));
      await markPending(ctx.db, { noteId: n.id, at: new Date(Date.now() - 3_000), add: [{ user_id: admin.id, agent_label: null }], ref: null, spaceKey: `u:${admin.id}` });
      return n.id;
    };
    const a = await seedPending("測試縫");
    expect(await ctx.collab.versions.scanDue()).toBe(0); // site setting is 5 minutes: a change from 3 s ago is not due yet
    expect((await put(ctx.app, admin.id, { seconds: 2 })).statusCode).toBe(204);
    expect(await ctx.collab.versions.scanDue()).toBe(1);
    expect(await versionsOf(ctx.db, a)).toHaveLength(1);
    expect((await put(ctx.app, admin.id, { seconds: null })).statusCode).toBe(204);
    const b = await seedPending("回站台設定");
    expect(await ctx.collab.versions.scanDue()).toBe(0);
    expect(await versionsOf(ctx.db, b)).toEqual([]);
  });
});
