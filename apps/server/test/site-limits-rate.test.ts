import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import { seedAttachment } from "./storage-helpers.js";

const PW = "correct horse battery staple";
const search = () => new FixedWindowLimiter({ limit: 60, windowMs: 60_000 });

describe("rateEdit takes effect immediately", () => {
  it("collab harness, POST /api/notes/:id/edits: 4th after 3 is 429; after resetting to null, another user's 4 requests are none 429", async () => {
    const ctx = await buildCollabTestApp({ limiters: { search: search() } });
    try {
      const admin = await ctx.createUser({ email: "admin-rate@example.com", password: PW, isAdmin: true });
      const alice = await ctx.createUser({ email: "alice-rate@example.com", password: PW });
      const noteA = await ctx.createNote(alice.id);
      const { token } = await seedTokenForUser(ctx.db, alice.id, "notes:read notes:write");
      await ctx.siteLimits.update(admin.id, { rateEdit: 3 });
      const post = (t: string, id: string) =>
        ctx.app.inject({ method: "POST", url: `/api/notes/${id}/edits`, headers: bearer(t), payload: { op: "append", markdown: "x" } });
      for (let i = 0; i < 3; i += 1) expect((await post(token, noteA.id)).statusCode).toBe(201);
      expect((await post(token, noteA.id)).statusCode).toBe(429);
      await ctx.siteLimits.update(admin.id, { rateEdit: null });
      const bob = await ctx.createUser({ email: "bob-rate@example.com", password: PW });
      const noteB = await ctx.createNote(bob.id);
      const { token: tokB } = await seedTokenForUser(ctx.db, bob.id, "notes:read notes:write");
      for (let i = 0; i < 4; i += 1) expect((await post(tokB, noteB.id)).statusCode).not.toBe(429);
    } finally {
      await ctx.destroy();
    }
  });

  it("buildTestApp, POST /api/notes/:id/copy: rateEdit 3 -> 4th is 429", async () => {
    const { app, db, siteLimits } = await buildTestApp({ limiters: freshLimiters({ search: search() }) });
    const admin = await seedUser(db, { isAdmin: true });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const cookies = await cookieOf(me.id);
    await siteLimits.update(admin.id, { rateEdit: 3 });
    const copy = () => app.inject({ method: "POST", url: `/api/notes/${src.id}/copy`, cookies, payload: {} });
    for (let i = 0; i < 3; i += 1) expect((await copy()).statusCode).toBe(201);
    expect((await copy()).statusCode).toBe(429);
  });
});

describe("changing rateUpload changes the MCP message", () => {
  it("rateUpload 12 with the bucket full -> copy_note error message contains 12 files per 10 minutes", async () => {
    const { app, db, uploadsDir, siteLimits } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedAttachment(db, uploadsDir, src.id, me.id, 10));
    await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
    const { token } = await seedTokenForUser(db, me.id, "notes:read notes:write");
    await siteLimits.update(admin.id, { rateUpload: 12 });
    const call = async (a: FastifyInstance) => {
      const res = await mcpPost(a, rpc("tools/call", { name: "copy_note", arguments: { note_id: src.id } }), { token });
      expect(res.statusCode).toBe(200);
      return res.json().result as { isError?: true; structuredContent?: { code?: string; message?: string } };
    };
    const first = await call(app);
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
    const second = await call(app);
    expect(second.structuredContent?.code).toBe("too_many_requests");
    expect(second.structuredContent?.message).toContain("12 files per 10 minutes");
  });
});

describe("overridden buckets are not affected by PATCH", () => {
  it("limiters.edit given as 5 -> the 4th and 5th after rateEdit 3 are still 2xx", async () => {
    const { app, db, siteLimits } = await buildTestApp({
      limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 5, windowMs: 60_000 }) }),
    });
    const admin = await seedUser(db, { isAdmin: true });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const cookies = await cookieOf(me.id);
    await siteLimits.update(admin.id, { rateEdit: 3 });
    const copy = () => app.inject({ method: "POST", url: `/api/notes/${src.id}/copy`, cookies, payload: {} });
    for (let i = 0; i < 5; i += 1) expect((await copy()).statusCode).toBe(201);
    expect((await copy()).statusCode).toBe(429);
  });
});
