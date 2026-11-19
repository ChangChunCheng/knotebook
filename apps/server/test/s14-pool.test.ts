/**
 * A small pool (max=3) with max+1 concurrent custom-slug renames (each note's old slug is custom and a redirect row exists
 * on the same path, so `patchSlugInTx`'s DELETE branch runs). All 200, redirects all deleted, other requests fine afterwards.
 * The pool has a 2 s connection-acquire timeout, so borrowing a second pool connection while holding a transaction connection shows as a 500
 * instead of hanging the test until it times out; it is built with production's `createPool`, whose acquire timeout is that fuse.
 * A hook inside `patchSlugInTx` acts as a barrier: released once 3 transactions hold connections at once (or after 1 s).
 */
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { groups, noteRedirects, notes } from "../src/db/schema.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import { loadNoteAudience } from "../src/notes/service.js";
import { createDb } from "../src/db/index.js";
import type { Db } from "../src/db/index.js";
import { createPool } from "../src/db/pool.js";
import { UserGate } from "../src/auth/session.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRedirect, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";

describe("PATCH short transactions do not deadlock on a small pool", () => {
  it("max=3, 4 concurrent custom renames -> all 200, redirects all deleted; GET /api/notes works afterwards", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 });
    const db = createDb(pool);
    let arrived = 0;
    const barrier = async () => {
      arrived++;
      const deadline = Date.now() + 1_000;
      while (arrived < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    };
    const { app } = await buildTestApp({ db, gate: new UserGate(db), slugPatchTestHook: async point => { if (point === "slug-written") await barrier(); } });
    try {
      const users = await Promise.all(Array.from({ length: 4 }, () => seedUser(target.db)));
      const notesById = await Promise.all(users.map(u => seedNote(target.db, { ownerId: u.id }, { slug: "c", slugIsCustom: true })));
      await Promise.all(users.map((u, i) => seedRedirect(target.db, `/n/${u.handle}/c`, notesById[i]!.id)));
      const results = await Promise.all(users.map(async (u, i) =>
        app.inject({ method: "PATCH", url: `/api/notes/${notesById[i]!.id}`, cookies: await cookieOf(u.id), payload: { slug: "c2" } })));
      expect(results.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(await target.db.select().from(noteRedirects)).toEqual([]);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(users[0]!.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });
});

/**
 * Delete-all-notes shape: `DELETE /api/groups/:id` `{ mode: "delete" }` opens its gate (`beforeNoteDeleted`) before the
 * transaction; inside the transaction only tx is used. The fake gate must really borrow a connection (`loadNoteAudience(db, ...)`,
 * the same call the production gate makes in collab/server.ts) or a noop gate never touches the pool. Two barriers:
 * `group-delete-locked` (in the transaction) waits for 3 transactions holding connections at once (or 1 s); the fake gate waits
 * for calls from 3 different groups (or 1 s) - counting calls alone is not enough, since each group has 2 notes and 3 calls
 * could come from only 2 transactions.
 */
describe("deleting a group (delete mode) does not deadlock on a small pool", () => {
  const POOL_OPTS = { databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 } as const;

  function makeGate(db: Db, groupOfNote: Map<string, string>, distinctGroups: number) {
    // Rounds are numbered by how many times this note has been gated: correct code has only round 0 (outside the tx). Keeping
    // the outside gate and also opening one inside the tx would add round 1 (inside, 3 txs holding connections), which
    // waits for 3 different groups to arrive and so borrows connections simultaneously and drains the pool. A single-set barrier
    // misses it: round 0's set is already full, the in-tx round passes straight through, transactions borrow staggered, and
    // all status codes stay 204 so only the gate-count assertion goes red. The per-round barrier is stricter; a pure move
    // (gate moved into the tx with no outside copy) is caught by both.
    const roundOf = new Map<string, number>();
    const arrivedByRound = new Map<number, Set<string>>();
    const stat = { opened: 0, released: 0 };
    const beforeNoteDeleted = async (noteId: string) => {
      if (distinctGroups > 0) {
        const round = roundOf.get(noteId) ?? 0;
        roundOf.set(noteId, round + 1);
        const arrived = arrivedByRound.get(round) ?? new Set<string>();
        arrivedByRound.set(round, arrived);
        arrived.add(groupOfNote.get(noteId) ?? noteId);
        const deadline = Date.now() + 1_000;
        while (arrived.size < distinctGroups && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      }
      await loadNoteAudience(db, noteId);
      stat.opened++;
      return { release: () => { stat.released++; } };
    };
    return { beforeNoteDeleted, stat };
  }

  const del = async (app: FastifyInstance, userId: string, groupId: string) =>
    app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });

  it("max=3, 4 concurrent delete-alls (four groups of 2 notes) -> all 204, notes deleted; GET /api/notes works afterwards", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const groupOfNote = new Map<string, string>();
    const gate = makeGate(db, groupOfNote, 3);
    let inTx = 0;
    const barrier = async () => {
      inTx++;
      const deadline = Date.now() + 1_000;
      while (inTx < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    };
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
      groupTestHook: async point => { if (point === "group-delete-locked") await barrier(); },
    });
    try {
      const users = await Promise.all(Array.from({ length: 4 }, () => seedUser(target.db)));
      const groupIds: string[] = [];
      const noteIds: string[] = [];
      for (const [i, u] of users.entries()) {
        const g = await seedGroup(target.db, `S14-a-${i}`, [{ userId: u.id, role: "admin" }]);
        groupIds.push(g.id);
        for (let k = 0; k < 2; k++) {
          const n = await seedNote(target.db, { groupId: g.id });
          noteIds.push(n.id);
          groupOfNote.set(n.id, g.id);
        }
      }
      const results = await Promise.all(users.map((u, i) => del(app, u.id, groupIds[i]!)));
      expect(results.map(r => r.statusCode)).toEqual([204, 204, 204, 204]);
      expect(await target.db.select({ id: notes.id }).from(notes).where(inArray(notes.id, noteIds))).toEqual([]);
      expect(await target.db.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds))).toEqual([]);
      expect(gate.stat.opened).toBe(8);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(users[0]!.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });

  it("max=3, 4 concurrent delete-alls on the same group -> exactly one 204, three 404 not_found; the gates opened by the 404 requests are all released; GET /api/notes works afterwards", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const gate = makeGate(db, new Map(), 0);
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
    });
    try {
      const admin = await seedUser(target.db);
      const g = await seedGroup(target.db, "S14-a2", [{ userId: admin.id, role: "admin" }]);
      const ids = [(await seedNote(target.db, { groupId: g.id })).id, (await seedNote(target.db, { groupId: g.id })).id];
      const results = await Promise.all(Array.from({ length: 4 }, () => del(app, admin.id, g.id)));
      const codes = results.map(r => r.statusCode).sort();
      expect(codes).toEqual([204, 404, 404, 404]);
      for (const r of results) if (r.statusCode === 404) expect(r.json().error.code).toBe("not_found");
      expect(await target.db.select({ id: notes.id }).from(notes).where(inArray(notes.id, ids))).toEqual([]);
      // The winner's gate is not released (deletion succeeded; the gate is left to the TTL / the delete itself); every other
      // request's gate is released. The winner's note list is always those 2 notes (nobody can delete them before it commits),
      // so released = opened - 2.
      expect(gate.stat.opened).toBeGreaterThanOrEqual(2);
      expect(gate.stat.released).toBe(gate.stat.opened - 2);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(admin.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });

  // Guards "inside the transaction after lockGroup, no further borrowing from the pool": borrowing one more connection there
  // (a `select 1` on the small pool) drains the pool; without the protection the previous cases and this one all fail with 500.
  it("max=3, 1 delete-all plus 3 note creations in that group (sent only while the delete-all holds the lock) -> delete-all 204, creations all 404 group_not_found; fine afterwards", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const gate = makeGate(db, new Map(), 0);
    const state: { creates?: Array<Promise<LightMyRequestResponse>>; fired?: boolean; interleave?: string } = {};
    let fire: (() => Array<Promise<LightMyRequestResponse>>) | undefined;
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
      groupTestHook: async point => {
        if (point !== "group-delete-locked" || state.fired) return;
        state.fired = true;
        state.creates = fire!();
        // Watch lock waits with target.pool (not the small pool): the small pool may be full by now.
        state.interleave = await waitForBlockedOrSettled(target.db.$client, Promise.race(state.creates));
      },
    });
    try {
      const admin = await seedUser(target.db);
      const g = await seedGroup(target.db, "S14-b", [{ userId: admin.id, role: "admin" }]);
      await seedNote(target.db, { groupId: g.id });
      await seedNote(target.db, { groupId: g.id });
      const cookies = await cookieOf(admin.id);
      fire = () => Array.from({ length: 3 }, () => app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id } }));
      const deleted = await del(app, admin.id, g.id);
      const creates = await Promise.all(state.creates!);
      expect(state.interleave).toBe("blocked");
      expect(deleted.statusCode).toBe(204);
      expect(creates.map(r => r.statusCode)).toEqual([404, 404, 404]);
      for (const r of creates) expect(r.json().error.code).toBe("group_not_found");
      expect(await target.db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, g.id))).toEqual([]);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });
});
