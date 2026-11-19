/**
 * The `folders/service.ts` write paths (REST and MCP share them) charge their own `folder` bucket (`FOLDER_LIMIT`, http/rate-limit.ts), not the content-write `edit` bucket (`EDIT_LIMIT` 30/min).
 * Regression guarded: moving 31+ notes at once in the sidebar selection mode got 429 from the 31st on, and also used up that minute's AI-edit quota.
 *
 * Load-bearing: wiring `foldersRoutes`/`mcpRoutes` in `app.ts` back to the `edit` instance (shared bucket) turns the first, second and fourth cases red;
 * any of the four service functions not charging the `folder` bucket turns the third case red.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { TokenScope } from "@knotebook/shared";
import { EDIT_LIMIT, FixedWindowLimiter, FOLDER_LIMIT } from "../src/http/rate-limit.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { noteFolderCols, seedFolder } from "./folder-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { callTool } from "./mcp-folder-helpers.js";
import { inject } from "./trash-helpers.js";

const RW: TokenScope = "notes:read notes:write";

/** Remaining count (exhausts it; cap 1000 to prevent an infinite loop). */
function remaining(l: FixedWindowLimiter, key: string): number {
  let n = 0;
  while (n <= 1000 && l.consume(key)) n += 1;
  return n;
}

function status(res: LightMyRequestResponse, expected: number): void {
  expect(res.statusCode, res.body).toBe(expected);
}

const place = (app: FastifyInstance, userId: string, noteId: string, folderId: string | null) =>
  inject(app, "PUT", `/api/notes/${noteId}/folder`, userId, { folderId });

describe("folder bucket separate from the edit bucket", () => {
  it("production defaults: 40 consecutive placements into folders + 5 folder moves (45 in total) all 200; the edit bucket is never charged", async () => {
    expect(EDIT_LIMIT.limit).toBeLessThan(45);
    expect(FOLDER_LIMIT.limit).toBeGreaterThanOrEqual(45);
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const folder = new FixedWindowLimiter(FOLDER_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, folder }) });
    const u = await seedUser(db);
    const target = (await seedFolder(db, { personal: u.id }, { name: "target" })).id;
    const notes: string[] = [];
    for (let i = 0; i < 40; i += 1) notes.push((await seedNote(db, { ownerId: u.id })).id);
    const subs: string[] = [];
    for (let i = 0; i < 5; i += 1) subs.push((await seedFolder(db, { personal: u.id }, { name: `sub-${i}` })).id);

    for (const id of notes) status(await place(app, u.id, id, target), 200);
    for (const id of subs) status(await inject(app, "PATCH", `/api/folders/${id}`, u.id, { parentId: target }), 200);

    for (const id of notes) expect((await noteFolderCols(db.$client, id))?.folder_id).toBe(target);
    expect(remaining(edit, u.id)).toBe(EDIT_LIMIT.limit);
    expect(remaining(folder, u.id)).toBe(FOLDER_LIMIT.limit - 45);
  });

  it("edit bucket exhausted (0): create, rename, move, place and delete folder still succeed", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;

    const created = await inject(app, "POST", "/api/folders", u.id, { name: "A", space: { kind: "personal" } });
    status(created, 201);
    const a = (created.json() as { id: string }).id;
    const b = (await seedFolder(db, { personal: u.id }, { name: "B" })).id;
    status(await inject(app, "PATCH", `/api/folders/${a}`, u.id, { name: "A2" }), 200);
    status(await inject(app, "PATCH", `/api/folders/${b}`, u.id, { parentId: a }), 200);
    status(await place(app, u.id, n, b), 200);
    status(await place(app, u.id, n, null), 200);
    status(await inject(app, "DELETE", `/api/folders/${a}`, u.id), 200);
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders");
    expect(rows[0]!.n).toBe(0);
  });

  it("folder bucket limit 4: after one call of each of the four, the fifth is 429 too_many_requests and writes nothing; the edit bucket isn't charged", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const folder = new FixedWindowLimiter({ limit: 4, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, folder }) });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;
    const keep = (await seedFolder(db, { personal: u.id }, { name: "keep" })).id;
    const gone = (await seedFolder(db, { personal: u.id }, { name: "gone" })).id;

    status(await inject(app, "POST", "/api/folders", u.id, { name: "C", space: { kind: "personal" } }), 201);
    status(await inject(app, "PATCH", `/api/folders/${keep}`, u.id, { name: "keep2" }), 200);
    status(await place(app, u.id, n, keep), 200);
    status(await inject(app, "DELETE", `/api/folders/${gone}`, u.id), 200);

    const limited = await place(app, u.id, n, null);
    status(limited, 429);
    expect(limited.json()).toEqual({ error: { code: "too_many_requests", message: "Too many writes. Wait a moment and try again." } });
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(keep);
    status(await inject(app, "POST", "/api/folders", u.id, { name: "D", space: { kind: "personal" } }), 429);
    status(await inject(app, "PATCH", `/api/folders/${keep}`, u.id, { name: "keep3" }), 429);
    status(await inject(app, "DELETE", `/api/folders/${keep}`, u.id), 429);
    const { rows } = await db.$client.query<{ name: string }>("select name from folders order by name");
    expect(rows.map(r => r.name)).toEqual(["C", "keep2"]);
    expect(remaining(edit, u.id)).toBe(EDIT_LIMIT.limit);
  });

  it("MCP folder tools charge the same folder bucket: with edit at 0 move_note_to_folder still succeeds; with folder at 0 too_many_requests", async () => {
    const folder = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }), folder }),
    });
    const u = await seedUser(db);
    const n = (await seedNote(db, { ownerId: u.id })).id;
    const f = (await seedFolder(db, { personal: u.id }, { name: "F" })).id;
    const auth = { token: (await seedTokenForUser(db, u.id, RW)).token };

    const first = await callTool(app, auth, "move_note_to_folder", { note_id: n, folder_id: f });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeUndefined();
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(f);
    // The same instance: after MCP uses up the only one, REST is blocked too.
    status(await place(app, u.id, n, null), 429);
    const second = await callTool(app, auth, "move_note_to_folder", { note_id: n, folder_id: null });
    expect([second.isError, second.structuredContent]).toEqual([
      true,
      { code: "too_many_requests", message: "Too many folder changes right now, so nothing was changed. Try again in a moment." },
    ]);
    expect((await noteFolderCols(db.$client, n))?.folder_id).toBe(f);
  });
});
